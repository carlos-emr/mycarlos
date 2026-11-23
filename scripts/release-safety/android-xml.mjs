// Decoders for the three forms an Android manifest or XML resource comes in, each giving the same
// thing: a flat list of elements `{ name, attrs }` (attribute names without their namespace, values
// as strings, so a boolean is "true" or "false"). Nesting is not needed by the gate.
//
//   plain text XML   a merged manifest in a Gradle build folder, or a generated project's file
//   binary XML       what an APK holds (AXML: string pool, resource map, element chunks)
//   protobuf XML     what an AAB holds (aapt2's `XmlNode`)

/** A plain text XML document: every start tag with its attributes. */
export function decodePlainXml(text) {
  const elements = [];
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  for (const tag of stripped.matchAll(
    /<([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*\/?>/g,
  )) {
    const attrs = {};
    for (const attr of tag[2].matchAll(
      /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g,
    )) {
      attrs[attr[1].replace(/^[\w.-]+:/, "")] = attr[3] ?? attr[4];
    }
    elements.push({ name: tag[1].replace(/^[\w.-]+:/, ""), attrs });
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

function readPool(bytes, at) {
  const count = bytes.readUInt32LE(at + 8);
  const flags = bytes.readUInt32LE(at + 16);
  const stringsStart = bytes.readUInt32LE(at + 20);
  const headerSize = bytes.readUInt16LE(at + 2);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = at + stringsStart + bytes.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      // two lengths (characters, then bytes), each one byte or two when the high bit is set
      const skip = () => (bytes[p] & 0x80 ? (p += 2) : (p += 1));
      skip();
      let length =
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
  let at = bytes.readUInt16LE(2);
  while (at + 8 <= bytes.length) {
    const type = bytes.readUInt16LE(at);
    const size = bytes.readUInt32LE(at + 4);
    if (size < 8) throw new Error("damaged binary XML chunk");
    if (type === RES_STRING_POOL) {
      strings = readPool(bytes, at);
    } else if (type === RES_XML_START_ELEMENT) {
      const body = at + 16;
      const name = strings[bytes.readUInt32LE(body + 4)] ?? "";
      const attributeStart = bytes.readUInt16LE(body + 8);
      const attributeSize = bytes.readUInt16LE(body + 10);
      const attributeCount = bytes.readUInt16LE(body + 12);
      const attrs = {};
      for (let i = 0; i < attributeCount; i++) {
        const a = body + attributeStart + i * attributeSize;
        const attrName = strings[bytes.readUInt32LE(a + 4)] ?? "";
        const raw = bytes.readUInt32LE(a + 8);
        const dataType = bytes[a + 15];
        const data = bytes.readUInt32LE(a + 16);
        let value;
        if (dataType === TYPE_BOOLEAN) value = data !== 0 ? "true" : "false";
        else if (dataType === TYPE_STRING) value = strings[data] ?? "";
        else if (dataType === TYPE_INT_DEC)
          value = String(bytes.readInt32LE(a + 16));
        else if (dataType === TYPE_INT_HEX) value = `0x${data.toString(16)}`;
        else if (raw !== 0xffffffff) value = strings[raw] ?? "";
        else value = String(data);
        attrs[attrName] = value;
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
    const byte = bytes[at++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
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

function protoElement(bytes, elements) {
  let name = "";
  const attrs = {};
  const children = [];
  for (const { field, value } of fields(bytes)) {
    if (field === 3) name = value.toString("utf8");
    else if (field === 4) {
      let attrName = "";
      let attrValue = "";
      for (const part of fields(value)) {
        if (part.field === 2) attrName = part.value.toString("utf8");
        else if (part.field === 3) attrValue = part.value.toString("utf8");
      }
      attrs[attrName] = attrValue;
    } else if (field === 5) children.push(value);
  }
  elements.push({ name, attrs });
  for (const child of children) {
    for (const node of fields(child))
      if (node.field === 1) protoElement(node.value, elements);
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
