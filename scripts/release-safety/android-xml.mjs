// Decoders for the three forms an Android manifest or XML resource comes in, each giving the same
// thing: a flat list of elements `{ name, attrs }`. Attributes are keyed with their namespace:
// `android:debuggable`, `tools:debuggable`, or bare `package` (no namespace), values as strings (a
// boolean is "true" or "false"; a resource reference is its id, never "false"). Nesting is not needed.
//
//   plain text XML   a merged manifest in a Gradle build folder, or a generated project's file
//   binary XML       what an APK holds (AXML: string pool, resource map, element chunks)
//   protobuf XML     what an AAB holds (aapt2's `XmlNode`)

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const TOOLS_NS = "http://schemas.android.com/tools";
const namespaced = (uri, name) =>
  uri === ANDROID_NS
    ? `android:${name}`
    : uri === TOOLS_NS
      ? `tools:${name}`
      : uri
        ? `${uri}:${name}`
        : name;

/** The attribute `name` in the android namespace (or, for `package`, with none). */
export const androidAttr = (element, name) => element.attrs[`android:${name}`];

// ---- plain text XML: a linear scanner (no regex over the whole text) ----

/** The most plain XML the gate reads (1 MiB): a manifest is a few KB, and more is not read at all. */
export const MAX_PLAIN_XML = 1 << 20;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (value) =>
  value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });

/** A plain text XML document: every start tag with its attributes. */
export function decodePlainXml(text) {
  if (text.length > MAX_PLAIN_XML)
    throw new Error(`the XML is larger than ${MAX_PLAIN_XML} bytes`);
  const prefixes = new Map([
    ["android", ANDROID_NS],
    ["tools", TOOLS_NS],
  ]);
  const elements = [];
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at])) at++;
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open < 0) break;
    at = open;
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end < 0) throw new Error("unterminated XML comment");
      at = end + 3;
    } else if (text.startsWith("<![CDATA[", at)) {
      const end = text.indexOf("]]>", at);
      if (end < 0) throw new Error("unterminated CDATA");
      at = end + 3;
    } else if (text.startsWith("<?", at) || text.startsWith("<!", at)) {
      const end = text.indexOf(">", at);
      if (end < 0) throw new Error("unterminated XML declaration");
      at = end + 1;
    } else if (text[at + 1] === "/") {
      const end = text.indexOf(">", at);
      if (end < 0) throw new Error("unterminated XML end tag");
      at = end + 1;
    } else {
      at++;
      const nameStart = at;
      while (at < text.length && !/[\s/>]/.test(text[at])) at++;
      const qualified = text.slice(nameStart, at);
      if (!qualified) throw new Error("an XML tag has no name");
      const raw = [];
      for (;;) {
        skipSpace();
        if (at >= text.length) throw new Error("unterminated XML tag");
        if (text[at] === ">" || (text[at] === "/" && text[at + 1] === ">")) {
          at += text[at] === ">" ? 1 : 2;
          break;
        }
        const keyStart = at;
        while (at < text.length && !/[\s=/>]/.test(text[at])) at++;
        const key = text.slice(keyStart, at);
        if (!key) throw new Error("an XML attribute has no name");
        skipSpace();
        if (text[at] !== "=")
          throw new Error(`the XML attribute ${key} has no value`);
        at++;
        skipSpace();
        const quote = text[at];
        if (quote !== '"' && quote !== "'")
          throw new Error(`the XML attribute ${key} is not quoted`);
        const end = text.indexOf(quote, at + 1);
        if (end < 0) throw new Error("an XML attribute value is not closed");
        raw.push([key, decodeEntities(text.slice(at + 1, end))]);
        at = end + 1;
      }
      for (const [key, value] of raw) {
        const declared = /^xmlns:([\w.-]+)$/.exec(key);
        if (declared) prefixes.set(declared[1], value);
      }
      const attrs = {};
      for (const [key, value] of raw) {
        if (key === "xmlns" || key.startsWith("xmlns:")) continue;
        const colon = key.indexOf(":");
        const uri =
          colon > 0
            ? (prefixes.get(key.slice(0, colon)) ?? key.slice(0, colon))
            : "";
        attrs[namespaced(uri, colon > 0 ? key.slice(colon + 1) : key)] = value;
      }
      elements.push({ name: qualified.replace(/^[\w.-]+:/, ""), attrs });
    }
  }
  return elements;
}

// ---- binary XML (AXML) ----

const RES_STRING_POOL = 0x0001;
const RES_XML_START_ELEMENT = 0x0102;
const TYPE_STRING = 0x03;
const TYPE_BOOLEAN = 0x12;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const NONE = 0xffffffff;

function readPool(bytes, at) {
  const count = bytes.readUInt32LE(at + 8);
  const flags = bytes.readUInt32LE(at + 16);
  const stringsStart = bytes.readUInt32LE(at + 20);
  const headerSize = bytes.readUInt16LE(at + 2);
  const utf8 = (flags & 0x100) !== 0;
  if (count > bytes.length)
    throw new Error("the string pool is larger than the file");
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = at + stringsStart + bytes.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      // two lengths (characters, then bytes), each one byte or two when the high bit is set
      p += bytes[p] & 0x80 ? 2 : 1;
      const length =
        bytes[p] & 0x80 ? ((bytes[p] & 0x7f) << 8) | bytes[p + 1] : bytes[p];
      p += bytes[p] & 0x80 ? 2 : 1;
      strings.push(bytes.toString("utf8", p, p + length));
    } else {
      let length = bytes.readUInt16LE(p);
      p += 2;
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | bytes.readUInt16LE(p);
        p += 2;
      }
      strings.push(bytes.toString("utf16le", p, p + length * 2));
    }
  }
  return strings;
}

/** Binary XML (an APK's AndroidManifest.xml or res/xml file). */
export function decodeBinaryXml(bytes) {
  if (bytes.length < 8 || bytes.readUInt16LE(0) !== 0x0003)
    throw new Error("not binary XML");
  const elements = [];
  let strings = [];
  const string = (index) => {
    if (index >= strings.length)
      throw new Error("a string index is outside the string pool");
    return strings[index];
  };
  let at = bytes.readUInt16LE(2);
  while (at + 8 <= bytes.length) {
    const type = bytes.readUInt16LE(at);
    const size = bytes.readUInt32LE(at + 4);
    if (size < 8) throw new Error("damaged binary XML chunk");
    if (type === RES_STRING_POOL) {
      strings = readPool(bytes, at);
    } else if (type === RES_XML_START_ELEMENT) {
      const body = at + 16;
      const name = string(bytes.readUInt32LE(body + 4));
      const attributeStart = bytes.readUInt16LE(body + 8);
      const attributeSize = bytes.readUInt16LE(body + 10);
      const attributeCount = bytes.readUInt16LE(body + 12);
      const attrs = {};
      for (let i = 0; i < attributeCount; i++) {
        const a = body + attributeStart + i * attributeSize;
        const ns = bytes.readUInt32LE(a);
        const attrName = string(bytes.readUInt32LE(a + 4));
        const raw = bytes.readUInt32LE(a + 8);
        const dataType = bytes[a + 15];
        const data = bytes.readUInt32LE(a + 16);
        let value;
        if (dataType === TYPE_BOOLEAN) value = data !== 0 ? "true" : "false";
        else if (dataType === TYPE_STRING) value = string(data);
        else if (dataType === TYPE_INT_DEC)
          value = String(bytes.readInt32LE(a + 16));
        else if (dataType === TYPE_INT_HEX) value = `0x${data.toString(16)}`;
        else if (raw !== NONE) value = string(raw);
        else value = `@${data}`;
        attrs[namespaced(ns === NONE ? "" : string(ns), attrName)] = value;
      }
      elements.push({ name, attrs });
    }
    at += size;
  }
  return elements;
}

// ---- protobuf XML (an AAB's base/manifest/AndroidManifest.xml and base/res/xml files) ----

function varint(bytes, at) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (at >= bytes.length)
      throw new Error("a protobuf varint runs past the end");
    const byte = bytes[at++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("a protobuf varint is too long");
  }
  return [Number(result), at];
}

/** The fields of one protobuf message: `[{ field, wire, value }]`, value a number or a Buffer. */
function fields(bytes) {
  const found = [];
  let at = 0;
  while (at < bytes.length) {
    let tag;
    [tag, at] = varint(bytes, at);
    const field = tag >>> 3;
    const wire = tag & 7;
    let value;
    if (wire === 0) [value, at] = varint(bytes, at);
    else if (wire === 2) {
      let length;
      [length, at] = varint(bytes, at);
      if (at + length > bytes.length)
        throw new Error("a protobuf field runs past the end");
      value = bytes.subarray(at, at + length);
      at += length;
    } else if (wire === 1) {
      value = bytes.subarray(at, at + 8);
      at += 8;
    } else if (wire === 5) {
      value = bytes.subarray(at, at + 4);
      at += 4;
    } else throw new Error("unsupported protobuf wire type");
    found.push({ field, wire, value });
  }
  return found;
}

const MAX_DEPTH = 200;

function protoElement(bytes, elements, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("protobuf XML nested too deeply");
  let name = "";
  const attrs = {};
  const children = [];
  for (const { field, value } of fields(bytes)) {
    if (field === 3) name = value.toString("utf8");
    else if (field === 4) {
      let uri = "";
      let attrName = "";
      let attrValue = "";
      for (const part of fields(value)) {
        if (part.field === 1) uri = part.value.toString("utf8");
        else if (part.field === 2) attrName = part.value.toString("utf8");
        else if (part.field === 3) attrValue = part.value.toString("utf8");
      }
      attrs[namespaced(uri, attrName)] = attrValue;
    } else if (field === 5) children.push(value);
  }
  elements.push({ name, attrs });
  for (const child of children) {
    for (const node of fields(child))
      if (node.field === 1) protoElement(node.value, elements, depth + 1);
  }
}

/** Protobuf XML (an AAB's manifest or XML resource). */
export function decodeProtoXml(bytes) {
  const elements = [];
  for (const node of fields(bytes))
    if (node.field === 1) protoElement(node.value, elements);
  if (elements.length === 0) throw new Error("not protobuf XML");
  return elements;
}

/** Whichever form the bytes are in. */
export function decodeAnyXml(bytes) {
  if (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x0003)
    return decodeBinaryXml(bytes);
  const head = bytes.subarray(0, 64).toString("utf8").trimStart();
  if (head.startsWith("<")) return decodePlainXml(bytes.toString("utf8"));
  return decodeProtoXml(bytes);
}
