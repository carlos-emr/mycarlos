//! The sealed inbox (#49), stage 1: the key, the item format, sealing and opening as streams, the
//! caps as pure functions, and the strict file names. Nothing is wired yet; later stages seal
//! received files with it and import them at unlock. The design is
//! `mycarlos-49-sealed-inbox-design-20261124.md`.
//!
//! A file shared to myCarlos while it is locked cannot be written into the vault, which needs
//! the passphrase. It is sealed instead, with a **public** key, into a folder outside the vault,
//! so nothing is needed to seal and nothing readable is left behind:
//!
//! - the inbox key is derived from the vault's master key (HKDF, then HPKE `DeriveKeyPair`), so
//!   it is not stored and needs no vault format change;
//! - an item is one file: a fixed 80-byte header (the AAD of everything else), 1 MiB
//!   XChaCha20-Poly1305 chunks, and a fixed-size sealed trailer written after the body, holding
//!   the name, the time and the size that was actually streamed;
//! - the body and trailer keys are the HPKE context's exports, so no key is inside the file.
#![cfg_attr(not(test), allow(dead_code))]

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem, OpModeR,
    OpModeS, Serializable,
};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Seek, SeekFrom, Write};
use uuid::Uuid;
use zeroize::Zeroizing;

type K = X25519HkdfSha256;

const MAGIC: &[u8; 8] = b"MCINBOX1";
const FORMAT: u8 = 1;
/// magic 8, format 1, reserved 7, item id 16, key id 16, HPKE encapsulated key 32.
pub(crate) const HEADER_LEN: usize = 80;
/// The sealed meta is padded to this size, so a name never changes the size of an item.
const META_PLAIN: usize = 1024;
const TAG: usize = 16;
pub(crate) const TRAILER_LEN: usize = META_PLAIN + TAG;
/// The plaintext size of one body chunk (the vault object's own).
pub(crate) const CHUNK: usize = 1024 * 1024;
/// The longest file name kept, in bytes; a longer one is cut at a character boundary.
pub(crate) const NAME_MAX: usize = 512;
const META_NAME_AT: usize = 20;
/// The longest file an item may hold: the PDF helper's own limit, so that an item the inbox takes is one
/// the reader can open.
pub(crate) const MAX_FILE_BYTES: u64 = crate::pdf_unlock::MAX_LOCKED_PDF_BYTES as u64;

const HPKE_INFO: &[u8] = b"mycarlos/inbox/v1";
const BODY_KEY_LABEL: &[u8] = b"mycarlos/inbox/body-key/v1";
const META_KEY_LABEL: &[u8] = b"mycarlos/inbox/meta-key/v1";
const KEYPAIR_LABEL: &[u8] = b"mycarlos/inbox-x25519/v1";
const RECORD_ID_LABEL: &[u8] = b"mycarlos/inbox-record-id/v1";
const KEY_ID_LABEL: &[u8] = b"mycarlos/inbox/key-id/v1";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InboxError {
    /// Not an inbox item, or an item of a format this build does not know, or a length that no
    /// sealer would have written.
    Malformed,
    /// A check failed: the item was changed, cut, reordered or made for something else.
    Tampered,
    /// The item is sealed to another key.
    WrongKey,
    /// The file is longer than `MAX_FILE_BYTES`.
    TooLarge,
    /// An empty file is not a document.
    Empty,
    Cancelled,
    /// The public key is not one an item may be sealed to.
    BadPublicKey,
    Io(io::ErrorKind),
}

impl From<io::Error> for InboxError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.kind())
    }
}

/// Where the file came from, as the page says it ("shared" or "opened").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Source {
    Shared = 0,
    Opened = 1,
}

impl Source {
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Shared),
            1 => Some(Self::Opened),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ItemId(pub(crate) [u8; 16]);

impl ItemId {
    pub(crate) fn random() -> Self {
        let mut bytes = [0_u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
        Self(bytes)
    }
    pub(crate) fn hex(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct KeyId(pub(crate) [u8; 16]);

/// What the sealed trailer says about an item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ItemMeta {
    /// The name the sealer was given, bounded to `NAME_MAX` bytes. It comes from another app: the
    /// importing stage cleans it again with the vault's own rename rules before it names a record.
    pub(crate) name: String,
    pub(crate) received_at: u64,
    pub(crate) source: Source,
    /// The size of the file as it was streamed in, not as anyone declared it.
    pub(crate) plaintext_size: u64,
}

/// The public half of the inbox key: all that sealing needs, and nothing that opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InboxPublic {
    bytes: [u8; 32],
}

/// The operating system's random numbers, for HPKE's random-number traits (its `rand_core` is not
/// the one `rand` uses).
struct OsRng;

impl hpke::rand_core::RngCore for OsRng {
    fn next_u32(&mut self) -> u32 {
        rand::RngCore::next_u32(&mut rand::rngs::OsRng)
    }
    fn next_u64(&mut self) -> u64 {
        rand::RngCore::next_u64(&mut rand::rngs::OsRng)
    }
    fn fill_bytes(&mut self, bytes: &mut [u8]) {
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, bytes);
    }
}
impl hpke::rand_core::CryptoRng for OsRng {}

impl InboxPublic {
    /// The key as read from `inbox.pub` or derived: exactly 32 bytes, not all zero, and not a
    /// low-order point.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, InboxError> {
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| InboxError::BadPublicKey)?;
        if bytes == [0_u8; 32] || !is_canonical_x25519(&bytes) {
            return Err(InboxError::BadPublicKey);
        }
        let key = Self { bytes };
        // Sealing to it must work: that is what a low-order point cannot do.
        hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, K, _>(
            &OpModeS::Base,
            &key.hpke_key()?,
            HPKE_INFO,
            &mut OsRng,
        )
        .map_err(|_| InboxError::BadPublicKey)?;
        Ok(key)
    }

    fn hpke_key(&self) -> Result<<K as Kem>::PublicKey, InboxError> {
        <K as Kem>::PublicKey::from_bytes(&self.bytes).map_err(|_| InboxError::BadPublicKey)
    }

    pub(crate) fn to_bytes(&self) -> [u8; 32] {
        self.bytes
    }

    pub(crate) fn key_id(&self) -> KeyId {
        let mut digest = Sha256::new();
        digest.update(KEY_ID_LABEL);
        digest.update(self.bytes);
        let mut id = [0_u8; 16];
        id.copy_from_slice(&digest.finalize()[..16]);
        KeyId(id)
    }
}

/// Whether `bytes` is the canonical encoding of an X25519 public key: the top bit clear and the value
/// below 2^255 - 19 (a key made by a scalar multiplication always is; the others are encodings
/// of a point another way, which no honest writer produces).
fn is_canonical_x25519(bytes: &[u8; 32]) -> bool {
    if bytes[31] & 0x80 != 0 {
        return false;
    }
    let at_or_above_p =
        bytes[31] == 0x7f && bytes[1..31].iter().all(|b| *b == 0xff) && bytes[0] >= 0xed;
    !at_or_above_p
}

/// How the `inbox.pub` file compares with the key derived at unlock.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PublicFileCheck {
    /// No file yet: the first write, not a tamper.
    Missing,
    Matches,
    /// A file that is there and is not the derived key (or is not a valid key at all): said to the
    /// patient, then replaced.
    Changed,
}

/// The inbox key pair of one vault, derived on demand and dropped after use.
pub(crate) struct InboxKeys {
    // The X25519 secret. It is wiped when dropped only because the `zeroize` feature of
    // `x25519-dalek` is on (Cargo.toml turns it on, and feature unification gives it to `hpke`'s
    // copy too): do not take that feature out, and look at it again if the HPKE crate changes.
    private: <K as Kem>::PrivateKey,
    public: InboxPublic,
    record_key: Zeroizing<[u8; 32]>,
}

impl InboxKeys {
    pub(crate) fn derive(master_key: &[u8; 32], vault_id: Uuid) -> Result<Self, InboxError> {
        let hkdf = hkdf::Hkdf::<Sha256>::new(Some(vault_id.as_bytes().as_slice()), master_key);
        let mut ikm = Zeroizing::new([0_u8; 32]);
        hkdf.expand(KEYPAIR_LABEL, ikm.as_mut())
            .map_err(|_| InboxError::Malformed)?;
        let mut record_key = Zeroizing::new([0_u8; 32]);
        hkdf.expand(RECORD_ID_LABEL, record_key.as_mut())
            .map_err(|_| InboxError::Malformed)?;
        let (private, public) = K::derive_keypair(ikm.as_ref());
        let public = InboxPublic::from_bytes(public.to_bytes().as_slice())?;
        Ok(Self {
            private,
            public,
            record_key,
        })
    }

    pub(crate) fn public(&self) -> &InboxPublic {
        &self.public
    }

    /// The record id the vault gives the document this item becomes: UUIDv4-shaped,
    /// `HMAC-SHA256(record_key, item_id)`, so importing the same item twice (a crash between the
    /// commit and the delete, with the document since moved to another profile) is recognised by
    /// an id that already exists.
    pub(crate) fn record_id(&self, item: &ItemId) -> Uuid {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.record_key.as_ref())
            .expect("an HMAC takes a key of any length");
        mac.update(&item.0);
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&mac.finalize().into_bytes()[..16]);
        uuid::Builder::from_random_bytes(bytes).into_uuid()
    }

    /// The file's bytes against this key.
    pub(crate) fn check_public_file(&self, file: Option<&[u8]>) -> PublicFileCheck {
        match file {
            None => PublicFileCheck::Missing,
            Some(bytes) if bytes == self.public.bytes => PublicFileCheck::Matches,
            Some(_) => PublicFileCheck::Changed,
        }
    }
}

struct Header {
    item_id: ItemId,
    key_id: KeyId,
    enc: [u8; 32],
}

impl Header {
    fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut out = [0_u8; HEADER_LEN];
        out[..8].copy_from_slice(MAGIC);
        out[8] = FORMAT;
        // 9..16 are reserved, zero.
        out[16..32].copy_from_slice(&self.item_id.0);
        out[32..48].copy_from_slice(&self.key_id.0);
        out[48..80].copy_from_slice(&self.enc);
        out
    }

    fn parse(bytes: &[u8; HEADER_LEN]) -> Result<Self, InboxError> {
        if &bytes[..8] != MAGIC || bytes[8] != FORMAT || bytes[9..16] != [0_u8; 7] {
            return Err(InboxError::Malformed);
        }
        let mut item_id = [0_u8; 16];
        item_id.copy_from_slice(&bytes[16..32]);
        let mut key_id = [0_u8; 16];
        key_id.copy_from_slice(&bytes[32..48]);
        let mut enc = [0_u8; 32];
        enc.copy_from_slice(&bytes[48..80]);
        Ok(Self {
            item_id: ItemId(item_id),
            key_id: KeyId(key_id),
            enc,
        })
    }
}

/// An item's identity from its first bytes, with no key: enough to count well-formed items on the
/// lock screen and to see which key an item is sealed to.
pub(crate) fn peek_header(bytes: &[u8]) -> Option<(ItemId, KeyId)> {
    let bytes: &[u8; HEADER_LEN] = bytes.get(..HEADER_LEN)?.try_into().ok()?;
    Header::parse(bytes)
        .ok()
        .map(|header| (header.item_id, header.key_id))
}

fn chunk_nonce(index: u64) -> [u8; 24] {
    let mut nonce = [0_u8; 24];
    nonce[16..].copy_from_slice(&index.to_be_bytes());
    nonce
}

fn chunk_aad(header: &[u8; HEADER_LEN], index: u64, final_chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HEADER_LEN + 9);
    aad.extend_from_slice(header);
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(final_chunk));
    aad
}

fn trailer_aad(header: &[u8; HEADER_LEN], body_len: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HEADER_LEN + 8);
    aad.extend_from_slice(header);
    aad.extend_from_slice(&body_len.to_be_bytes());
    aad
}

/// A name cut at a character boundary to `NAME_MAX` bytes.
fn bounded_name(name: &str) -> &str {
    let mut end = name.len().min(NAME_MAX);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    &name[..end]
}

fn encode_meta(meta: &ItemMeta) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(vec![0_u8; META_PLAIN]);
    let name = bounded_name(&meta.name);
    out[0] = 1;
    out[1..3].copy_from_slice(&(name.len() as u16).to_be_bytes());
    out[3..11].copy_from_slice(&meta.received_at.to_be_bytes());
    out[11..19].copy_from_slice(&meta.plaintext_size.to_be_bytes());
    out[19] = meta.source as u8;
    out[META_NAME_AT..META_NAME_AT + name.len()].copy_from_slice(name.as_bytes());
    out
}

fn decode_meta(bytes: &[u8]) -> Result<ItemMeta, InboxError> {
    if bytes.len() != META_PLAIN || bytes[0] != 1 {
        return Err(InboxError::Malformed);
    }
    let name_len = usize::from(u16::from_be_bytes([bytes[1], bytes[2]]));
    // Everything past the name is zero padding: a sealer wrote nothing else.
    if name_len > NAME_MAX || bytes[META_NAME_AT + name_len..].iter().any(|b| *b != 0) {
        return Err(InboxError::Malformed);
    }
    let name = std::str::from_utf8(&bytes[META_NAME_AT..META_NAME_AT + name_len])
        .map_err(|_| InboxError::Malformed)?
        .to_owned();
    Ok(ItemMeta {
        name,
        received_at: u64::from_be_bytes(
            bytes[3..11].try_into().map_err(|_| InboxError::Malformed)?,
        ),
        source: Source::from_byte(bytes[19]).ok_or(InboxError::Malformed)?,
        plaintext_size: u64::from_be_bytes(
            bytes[11..19]
                .try_into()
                .map_err(|_| InboxError::Malformed)?,
        ),
    })
}

/// The number of body chunks of a file of `size` bytes (at least one).
fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK as u64).max(1)
}

/// The length of an item's body for a file of `size` bytes: the bytes and one tag per chunk.
fn body_len(size: u64) -> u64 {
    size + TAG as u64 * chunk_count(size)
}

/// The size of the whole item file for a file of `size` bytes, as it lies on disk.
pub(crate) fn sealed_size(size: u64) -> u64 {
    HEADER_LEN as u64 + body_len(size) + TRAILER_LEN as u64
}

/// The two keys of an item, from its HPKE context.
type KeyPair = (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>);

fn item_keys(
    export: impl Fn(&[u8], &mut [u8]) -> Result<(), hpke::HpkeError>,
) -> Result<KeyPair, InboxError> {
    let mut body = Zeroizing::new([0_u8; 32]);
    let mut meta = Zeroizing::new([0_u8; 32]);
    export(BODY_KEY_LABEL, body.as_mut()).map_err(|_| InboxError::Malformed)?;
    export(META_KEY_LABEL, meta.as_mut()).map_err(|_| InboxError::Malformed)?;
    Ok((body, meta))
}

/// Reads until `buf` is full or the input ends, retrying an interrupted read.
fn read_full<R: Read>(input: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match input.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// Seals `input` into `output` as one inbox item for `public`, with `item_id` and the cleaned
/// `name`. The size limit (`max_bytes`, at most `MAX_FILE_BYTES`) is enforced while streaming, from
/// what is actually read, and the size in the trailer is that count. An empty input, a refused
/// size, a failed read or a cancel leaves a partial output that the caller deletes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn seal<R: Read, W: Write>(
    public: &InboxPublic,
    item_id: &ItemId,
    name: &str,
    received_at: u64,
    source: Source,
    input: R,
    output: W,
    max_bytes: u64,
    cancelled: &dyn Fn() -> bool,
) -> Result<ItemMeta, InboxError> {
    let name = bounded_name(name).to_owned();
    let mut sealed = None;
    seal_with_trailer(
        public,
        item_id,
        input,
        output,
        max_bytes,
        cancelled,
        &mut |plaintext_size| {
            let meta = ItemMeta {
                name: name.clone(),
                received_at,
                source,
                plaintext_size,
            };
            let plain = encode_meta(&meta);
            sealed = Some(meta);
            plain
        },
    )?;
    sealed.ok_or(InboxError::Malformed)
}

/// `seal`, with the trailer's plaintext made by `make_trailer` from the size actually streamed. The
/// one writer of the format: the tests give it trailers no real sealer would write, to hold
/// `open_item`'s refusals to account.
fn seal_with_trailer<R: Read, W: Write>(
    public: &InboxPublic,
    item_id: &ItemId,
    mut input: R,
    mut output: W,
    max_bytes: u64,
    cancelled: &dyn Fn() -> bool,
    make_trailer: &mut dyn FnMut(u64) -> Zeroizing<Vec<u8>>,
) -> Result<(), InboxError> {
    let max_bytes = max_bytes.min(MAX_FILE_BYTES);
    let (enc, context) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, K, _>(
        &OpModeS::Base,
        &public.hpke_key()?,
        HPKE_INFO,
        &mut OsRng,
    )
    .map_err(|_| InboxError::BadPublicKey)?;
    let mut enc_bytes = [0_u8; 32];
    enc_bytes.copy_from_slice(enc.to_bytes().as_slice());
    let header = Header {
        item_id: *item_id,
        key_id: public.key_id(),
        enc: enc_bytes,
    }
    .to_bytes();
    let (body_key, meta_key) = item_keys(|label, out| context.export(label, out))?;
    let body_cipher =
        XChaCha20Poly1305::new_from_slice(body_key.as_ref()).map_err(|_| InboxError::Malformed)?;
    output.write_all(&header)?;

    let mut current = Zeroizing::new(vec![0_u8; CHUNK]);
    let mut next = Zeroizing::new(vec![0_u8; CHUNK]);
    let mut current_len = read_full(&mut input, &mut current)?;
    if current_len == 0 {
        return Err(InboxError::Empty);
    }
    let mut total = 0_u64;
    let mut index = 0_u64;
    loop {
        if cancelled() {
            return Err(InboxError::Cancelled);
        }
        // A full chunk may be the last: only the input's end says so.
        let next_len = if current_len == CHUNK {
            read_full(&mut input, &mut next)?
        } else {
            0
        };
        let final_chunk = next_len == 0;
        total += current_len as u64;
        if total > max_bytes {
            return Err(InboxError::TooLarge);
        }
        let sealed = body_cipher
            .encrypt(
                XNonce::from_slice(&chunk_nonce(index)),
                Payload {
                    msg: &current[..current_len],
                    aad: &chunk_aad(&header, index, final_chunk),
                },
            )
            .map_err(|_| InboxError::Malformed)?;
        output.write_all(&sealed)?;
        if final_chunk {
            break;
        }
        std::mem::swap(&mut current, &mut next);
        current_len = next_len;
        index += 1;
    }

    let meta_cipher =
        XChaCha20Poly1305::new_from_slice(meta_key.as_ref()).map_err(|_| InboxError::Malformed)?;
    let trailer = meta_cipher
        .encrypt(
            XNonce::from_slice(&[0_u8; 24]),
            Payload {
                msg: &make_trailer(total),
                aad: &trailer_aad(&header, body_len(total)),
            },
        )
        .map_err(|_| InboxError::Malformed)?;
    output.write_all(&trailer)?;
    output.flush()?;
    Ok(())
}

/// An opened item: its meta, and a reader of the file's plaintext that checks every chunk as it
/// goes. A failed check is an `InvalidData` error, never a short or altered read.
pub(crate) struct OpenedItem<F: Read + Seek> {
    pub(crate) meta: ItemMeta,
    #[allow(dead_code)] // read by the unlock import (stage 3)
    pub(crate) item_id: ItemId,
    file: F,
    header: [u8; HEADER_LEN],
    cipher: XChaCha20Poly1305,
    body_remaining: u64,
    index: u64,
    plain: Zeroizing<Vec<u8>>,
    at: usize,
    produced: u64,
}

fn tampered() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the inbox item failed its checks",
    )
}

/// Opens an item with this vault's keys: the header, the trailer and every length are checked
/// before any plaintext is given. `expected` is the item id the file NAME gave: an item whose header
/// says another id (a file renamed over another, a copy moved under a new name) is refused.
pub(crate) fn open_item<F: Read + Seek>(
    keys: &InboxKeys,
    expected: &ItemId,
    mut file: F,
) -> Result<OpenedItem<F>, InboxError> {
    let length = file.seek(SeekFrom::End(0))?;
    let shortest = HEADER_LEN as u64 + body_len(1) + TRAILER_LEN as u64;
    if length < shortest || length > sealed_size(MAX_FILE_BYTES) {
        return Err(InboxError::Malformed);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; HEADER_LEN];
    file.read_exact(&mut header)?;
    let parsed = Header::parse(&header)?;
    if parsed.key_id != keys.public.key_id() {
        return Err(InboxError::WrongKey);
    }
    if parsed.item_id != *expected {
        return Err(InboxError::Tampered);
    }
    let enc =
        <K as Kem>::EncappedKey::from_bytes(&parsed.enc).map_err(|_| InboxError::Malformed)?;
    let context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, K>(
        &OpModeR::Base,
        &keys.private,
        &enc,
        HPKE_INFO,
    )
    .map_err(|_| InboxError::Tampered)?;
    let (body_key, meta_key) = item_keys(|label, out| context.export(label, out))?;

    let body = length - HEADER_LEN as u64 - TRAILER_LEN as u64;
    file.seek(SeekFrom::Start(length - TRAILER_LEN as u64))?;
    let mut trailer = vec![0_u8; TRAILER_LEN];
    file.read_exact(&mut trailer)?;
    let meta_cipher =
        XChaCha20Poly1305::new_from_slice(meta_key.as_ref()).map_err(|_| InboxError::Malformed)?;
    let plain = Zeroizing::new(
        meta_cipher
            .decrypt(
                XNonce::from_slice(&[0_u8; 24]),
                Payload {
                    msg: &trailer,
                    aad: &trailer_aad(&header, body),
                },
            )
            .map_err(|_| InboxError::Tampered)?,
    );
    let meta = decode_meta(&plain)?;
    // The size the sealer streamed must be the size of the body that is there.
    if meta.plaintext_size == 0
        || meta.plaintext_size > MAX_FILE_BYTES
        || body_len(meta.plaintext_size) != body
    {
        return Err(InboxError::Tampered);
    }
    file.seek(SeekFrom::Start(HEADER_LEN as u64))?;
    Ok(OpenedItem {
        meta,
        item_id: parsed.item_id,
        file,
        header,
        cipher: XChaCha20Poly1305::new_from_slice(body_key.as_ref())
            .map_err(|_| InboxError::Malformed)?,
        body_remaining: body,
        index: 0,
        plain: Zeroizing::new(Vec::new()),
        at: 0,
        produced: 0,
    })
}

impl<F: Read + Seek> Read for OpenedItem<F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.at == self.plain.len() {
            if self.body_remaining == 0 {
                // The whole body was read: its length was checked against the trailer's size.
                return if self.produced == self.meta.plaintext_size {
                    Ok(0)
                } else {
                    Err(tampered())
                };
            }
            let sealed_len = self.body_remaining.min((CHUNK + TAG) as u64);
            let final_chunk = self.body_remaining == sealed_len;
            let mut sealed = vec![0_u8; sealed_len as usize];
            self.file.read_exact(&mut sealed)?;
            let opened = self
                .cipher
                .decrypt(
                    XNonce::from_slice(&chunk_nonce(self.index)),
                    Payload {
                        msg: &sealed,
                        aad: &chunk_aad(&self.header, self.index, final_chunk),
                    },
                )
                .map_err(|_| tampered())?;
            self.body_remaining -= sealed_len;
            self.index += 1;
            self.plain = Zeroizing::new(opened);
            self.at = 0;
            self.produced += self.plain.len() as u64;
        }
        let count = buf.len().min(self.plain.len() - self.at);
        buf[..count].copy_from_slice(&self.plain[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

// ----- file names -----

/// `<32 lowercase hex>.mcin`
pub(crate) fn item_file_name(id: &ItemId) -> String {
    format!("{}.mcin", id.hex())
}

/// `<32 lowercase hex>.part`: an item being sealed.
pub(crate) fn part_file_name(id: &ItemId) -> String {
    format!("{}.part", id.hex())
}

fn parse_hex_name(name: &str, extension: &str) -> Option<ItemId> {
    let stem = name.strip_suffix(extension)?;
    if stem.len() != 32 || !stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut bytes = [0_u8; 16];
    for (i, pair) in stem.as_bytes().chunks(2).enumerate() {
        bytes[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(ItemId(bytes))
}

/// The item id of a file named exactly like an item, else `None`: nothing else in the folder is
/// ever opened, counted or deleted as an item.
pub(crate) fn parse_item_name(name: &str) -> Option<ItemId> {
    parse_hex_name(name, ".mcin")
}

/// The item id of a file named exactly like a part-sealed item.
pub(crate) fn parse_part_name(name: &str) -> Option<ItemId> {
    parse_hex_name(name, ".part")
}

// ----- caps -----

/// The limits (design: supervisor defaults, Ben may change them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Caps {
    pub(crate) items: usize,
    pub(crate) total_bytes: u64,
    pub(crate) file_bytes: u64,
    /// Free space that must remain after sealing.
    pub(crate) free_reserve: u64,
    pub(crate) age_secs: u64,
}

pub(crate) const CAPS: Caps = Caps {
    items: 100,
    total_bytes: 512 * 1024 * 1024,
    file_bytes: MAX_FILE_BYTES,
    free_reserve: 512 * 1024 * 1024,
    age_secs: 7 * 24 * 60 * 60,
};

/// The longest file a sealer may stream and `admit` accept: the caps' limit, never above the
/// format's own. `seal`'s `max_bytes` is this value, so the check before sealing and the count
/// while streaming cannot disagree.
pub(crate) fn file_limit(caps: &Caps) -> u64 {
    caps.file_bytes.min(MAX_FILE_BYTES)
}

/// What is in the folder: item files and, apart, part-sealed ones, whose bytes count too.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    pub(crate) items: usize,
    pub(crate) bytes: u64,
}

/// The one function that counts the folder: every entry as (file name, length). Item files count
/// as items; item and part files both count as bytes. Any other name counts as nothing (and is
/// never touched).
pub(crate) fn usage_of<'a>(entries: impl IntoIterator<Item = (&'a str, u64)>) -> Usage {
    let mut usage = Usage::default();
    for (name, length) in entries {
        if parse_item_name(name).is_some() {
            usage.items += 1;
            usage.bytes = usage.bytes.saturating_add(length);
        } else if parse_part_name(name).is_some() {
            usage.bytes = usage.bytes.saturating_add(length);
        }
    }
    usage
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    TooManyItems,
    FileTooLarge,
    InboxFull,
    NoRoom,
}

/// Whether one more file of up to `incoming` plaintext bytes may be sealed now, given what is
/// there (`usage`) and the free space. Every sealer calls this under the folder's lock.
pub(crate) fn admit(
    usage: &Usage,
    incoming: u64,
    free_space: u64,
    caps: &Caps,
) -> Result<(), Refusal> {
    if incoming > file_limit(caps) {
        return Err(Refusal::FileTooLarge);
    }
    if usage.items >= caps.items {
        return Err(Refusal::TooManyItems);
    }
    let size = sealed_size(incoming);
    if usage.bytes.saturating_add(size) > caps.total_bytes {
        return Err(Refusal::InboxFull);
    }
    if free_space < caps.free_reserve.saturating_add(size) {
        return Err(Refusal::NoRoom);
    }
    Ok(())
}

/// How far ahead of the clock a sealed `received_at` may be before the item is not believed (the
/// clock may have been set back since, or differ between the app and the system share handler).
pub(crate) const FUTURE_SLACK_SECS: u64 = 24 * 60 * 60;

/// Past its age, counted from the time sealed into it.
pub(crate) fn expired(received_at: u64, now: u64, caps: &Caps) -> bool {
    now.saturating_sub(received_at) >= caps.age_secs
}

/// What the sealed time says about an item at `now`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Age {
    Fresh,
    Expired,
    /// More than `FUTURE_SLACK_SECS` ahead of the clock: not a time this app wrote. Such an item is
    /// treated as malformed (it would otherwise never expire).
    FromTheFuture,
}

pub(crate) fn age_of(received_at: u64, now: u64, caps: &Caps) -> Age {
    if received_at > now.saturating_add(FUTURE_SLACK_SECS) {
        Age::FromTheFuture
    } else if expired(received_at, now, caps) {
        Age::Expired
    } else {
        Age::Fresh
    }
}

/// Long past its age, by a file time: the locked sweep's test (no key, so no sealed time), twice
/// the age so that it never removes what an unlock would still call fresh.
pub(crate) fn long_expired(file_time: u64, now: u64, caps: &Caps) -> bool {
    now.saturating_sub(file_time) >= caps.age_secs.saturating_mul(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn keys() -> InboxKeys {
        InboxKeys::derive(&[7_u8; 32], Uuid::from_u128(1)).unwrap()
    }

    fn pdf(len: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.4 FAKE ".to_vec();
        let mut seed = 0x9E37_79B9_u32;
        while bytes.len() < len {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            bytes.push((seed >> 24) as u8);
        }
        bytes.truncate(len);
        bytes
    }

    fn seal_bytes(keys: &InboxKeys, id: &ItemId, name: &str, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let meta = seal(
            keys.public(),
            id,
            name,
            1_792_454_400,
            Source::Shared,
            Cursor::new(data.to_vec()),
            &mut out,
            MAX_FILE_BYTES,
            &|| false,
        )
        .unwrap();
        assert_eq!(meta.plaintext_size, data.len() as u64);
        assert_eq!(out.len() as u64, sealed_size(data.len() as u64));
        out
    }

    fn open_all(keys: &InboxKeys, sealed: &[u8]) -> Result<(ItemMeta, Vec<u8>), InboxError> {
        // The id the file name would give: the header's own, unless there is no header to read.
        let expected = peek_header(sealed)
            .map(|(id, _)| id)
            .unwrap_or(ItemId([0; 16]));
        open_with_id(keys, &expected, sealed)
    }

    fn open_with_id(
        keys: &InboxKeys,
        expected: &ItemId,
        sealed: &[u8],
    ) -> Result<(ItemMeta, Vec<u8>), InboxError> {
        let mut item = open_item(keys, expected, Cursor::new(sealed.to_vec()))?;
        let meta = item.meta.clone();
        let mut out = Vec::new();
        item.read_to_end(&mut out)
            .map_err(|_| InboxError::Tampered)?;
        Ok((meta, out))
    }

    #[test]
    fn the_key_is_derived_from_the_master_key_and_the_vault_and_nothing_else() {
        let a = keys();
        let b = keys();
        assert_eq!(a.public(), b.public());
        assert_eq!(a.public().key_id(), b.public().key_id());
        // Another vault, or another master key, is another key.
        let other_vault = InboxKeys::derive(&[7_u8; 32], Uuid::from_u128(2)).unwrap();
        let other_master = InboxKeys::derive(&[8_u8; 32], Uuid::from_u128(1)).unwrap();
        assert_ne!(a.public(), other_vault.public());
        assert_ne!(a.public(), other_master.public());
        assert_ne!(a.public().key_id(), other_vault.public().key_id());
        // The public half round trips through the file's bytes.
        let from_file = InboxPublic::from_bytes(&a.public().to_bytes()).unwrap();
        assert_eq!(&from_file, a.public());
    }

    #[test]
    fn a_public_key_file_must_be_a_real_key() {
        let good = keys().public().to_bytes();
        assert!(InboxPublic::from_bytes(&good).is_ok());
        // Not 32 bytes.
        let too_long = [good.as_slice(), &[0_u8][..]].concat();
        for bad in [&good[..31], &too_long[..], &[][..]] {
            assert_eq!(InboxPublic::from_bytes(bad), Err(InboxError::BadPublicKey));
        }
        // All zero, and the low-order points X25519 knows (they all give a zero shared secret).
        let hex = |text: &str| -> Vec<u8> {
            (0..text.len() / 2)
                .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap())
                .collect()
        };
        for low_order in [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
            "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
            "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "0000000000000000000000000000000000000000000000000000000000000080",
        ] {
            assert_eq!(
                InboxPublic::from_bytes(&hex(low_order)),
                Err(InboxError::BadPublicKey),
                "{low_order}"
            );
        }
    }

    #[test]
    fn the_public_file_is_missing_matching_or_changed() {
        let keys = keys();
        assert_eq!(keys.check_public_file(None), PublicFileCheck::Missing);
        let own = keys.public().to_bytes();
        assert_eq!(
            keys.check_public_file(Some(own.as_slice())),
            PublicFileCheck::Matches
        );
        let other = InboxKeys::derive(&[9_u8; 32], Uuid::from_u128(1)).unwrap();
        for changed in [
            other.public().to_bytes().to_vec(),
            vec![],
            vec![0; 32],
            keys.public().to_bytes()[..31].to_vec(),
        ] {
            assert_eq!(
                keys.check_public_file(Some(changed.as_slice())),
                PublicFileCheck::Changed
            );
        }
    }

    #[test]
    fn record_ids_come_from_the_item_and_the_vault() {
        let keys = keys();
        let (first, second) = (ItemId([1; 16]), ItemId([2; 16]));
        assert_eq!(keys.record_id(&first), keys.record_id(&first));
        assert_ne!(keys.record_id(&first), keys.record_id(&second));
        // UUIDv4-shaped, so the vault takes it like any record id.
        let id = keys.record_id(&first);
        assert_eq!(id.get_version_num(), 4);
        assert!(!id.is_nil());
        let other = InboxKeys::derive(&[7_u8; 32], Uuid::from_u128(2)).unwrap();
        assert_ne!(other.record_id(&first), id);
    }

    #[test]
    fn items_round_trip_at_every_chunk_boundary() {
        let keys = keys();
        for len in [
            1,
            100,
            CHUNK - 1,
            CHUNK,
            CHUNK + 1,
            2 * CHUNK,
            2 * CHUNK + 5,
        ] {
            let data = pdf(len);
            let id = ItemId::random();
            let sealed = seal_bytes(&keys, &id, "FAKE Letter.pdf", &data);
            let (meta, opened) = open_all(&keys, &sealed).unwrap();
            assert_eq!(opened, data, "{len}");
            assert_eq!(meta.name, "FAKE Letter.pdf");
            assert_eq!(meta.plaintext_size, len as u64);
            assert_eq!(meta.received_at, 1_792_454_400);
            assert_eq!(meta.source, Source::Shared);
            assert_eq!(
                peek_header(&sealed),
                Some((id, keys.public().key_id())),
                "{len}"
            );
        }
    }

    #[test]
    fn a_name_never_changes_the_size_and_is_bounded() {
        let keys = keys();
        let data = pdf(2000);
        let short = seal_bytes(&keys, &ItemId::random(), "a.pdf", &data);
        let long_name = "é".repeat(400);
        let long = seal_bytes(&keys, &ItemId::random(), &long_name, &data);
        assert_eq!(short.len(), long.len());
        let (meta, _) = open_all(&keys, &long).unwrap();
        // 400 two-byte characters are 800 bytes: cut to the 512 that fit, on a boundary.
        assert_eq!(meta.name, "é".repeat(256));
        assert!(meta.name.len() <= NAME_MAX);
    }

    #[test]
    fn no_plaintext_or_name_appears_in_the_item() {
        let keys = keys();
        let data = pdf(5000);
        let sealed = seal_bytes(&keys, &ItemId::random(), "FAKE_secret_name.pdf", &data);
        let contains = |haystack: &[u8], needle: &[u8]| {
            haystack
                .windows(needle.len())
                .any(|window| window == needle)
        };
        assert!(!contains(&sealed, b"FAKE_secret_name"));
        assert!(!contains(&sealed, b"%PDF-1.4"));
        assert!(!contains(&sealed, &data[100..140]));
    }

    #[test]
    fn two_items_of_the_same_file_share_nothing() {
        let keys = keys();
        let data = pdf(3000);
        let a = seal_bytes(&keys, &ItemId::random(), "a.pdf", &data);
        let b = seal_bytes(&keys, &ItemId::random(), "a.pdf", &data);
        assert_ne!(
            a[HEADER_LEN..HEADER_LEN + 64],
            b[HEADER_LEN..HEADER_LEN + 64]
        );
    }

    #[test]
    fn a_change_anywhere_in_an_item_is_refused() {
        let keys = keys();
        let data = pdf(CHUNK + 100);
        let sealed = seal_bytes(&keys, &ItemId::random(), "FAKE.pdf", &data);
        // A flipped bit in the header (magic, item id, key id, encapsulated key), in each chunk,
        // and in the trailer.
        let mut places: Vec<usize> = vec![0, 8, 16, 31, 32, 47, 48, 79];
        places.extend([HEADER_LEN, HEADER_LEN + 1000, HEADER_LEN + CHUNK + TAG + 5]);
        places.extend([
            sealed.len() - 1,
            sealed.len() - TRAILER_LEN,
            sealed.len() - 500,
        ]);
        for place in places {
            let mut changed = sealed.clone();
            changed[place] ^= 1;
            assert!(
                open_all(&keys, &changed).is_err(),
                "a flipped bit at {place} was accepted"
            );
        }
        // Cut short, extended, and with a chunk removed.
        assert!(open_all(&keys, &sealed[..sealed.len() - 1]).is_err());
        let mut longer = sealed.clone();
        longer.push(0);
        assert!(open_all(&keys, &longer).is_err());
        assert!(open_all(&keys, &sealed[..HEADER_LEN]).is_err());
        assert!(open_all(&keys, &[]).is_err());
    }

    #[test]
    fn chunks_cannot_be_reordered_swapped_between_items_or_dropped() {
        let keys = keys();
        let data = pdf(3 * CHUNK + 10);
        let sealed = seal_bytes(&keys, &ItemId::random(), "FAKE.pdf", &data);
        let chunk = CHUNK + TAG;
        // Swap the first two chunks.
        let mut swapped = sealed.clone();
        let (first, second) = (
            sealed[HEADER_LEN..HEADER_LEN + chunk].to_vec(),
            sealed[HEADER_LEN + chunk..HEADER_LEN + 2 * chunk].to_vec(),
        );
        swapped[HEADER_LEN..HEADER_LEN + chunk].copy_from_slice(&second);
        swapped[HEADER_LEN + chunk..HEADER_LEN + 2 * chunk].copy_from_slice(&first);
        assert!(open_all(&keys, &swapped).is_err());
        // A chunk from another item (same size, same key id) in its place.
        let other = seal_bytes(&keys, &ItemId::random(), "FAKE.pdf", &data);
        let mut mixed = sealed.clone();
        mixed[HEADER_LEN..HEADER_LEN + chunk]
            .copy_from_slice(&other[HEADER_LEN..HEADER_LEN + chunk]);
        assert!(open_all(&keys, &mixed).is_err());
        // The trailer of another item.
        let mut trailer = sealed.clone();
        let at = trailer.len() - TRAILER_LEN;
        trailer[at..].copy_from_slice(&other[other.len() - TRAILER_LEN..]);
        assert!(open_all(&keys, &trailer).is_err());
        // A whole chunk dropped from the middle, the length no longer fitting the trailer.
        let mut dropped = sealed[..HEADER_LEN + chunk].to_vec();
        dropped.extend_from_slice(&sealed[HEADER_LEN + 2 * chunk..]);
        assert!(open_all(&keys, &dropped).is_err());
    }

    #[test]
    fn an_item_opens_only_with_its_own_vaults_key() {
        let keys = keys();
        let sealed = seal_bytes(&keys, &ItemId::random(), "FAKE.pdf", &pdf(500));
        let other_vault = InboxKeys::derive(&[7_u8; 32], Uuid::from_u128(2)).unwrap();
        assert_eq!(
            open_all(&other_vault, &sealed).map(|_| ()),
            Err(InboxError::WrongKey)
        );
        // The same key id with the wrong secret (a header copied onto another key's item) fails
        // its checks instead.
        let mut forged = sealed.clone();
        forged[32..48].copy_from_slice(&other_vault.public().key_id().0);
        assert_eq!(
            open_all(&other_vault, &forged).map(|_| ()),
            Err(InboxError::Tampered)
        );
    }

    #[test]
    fn the_size_limit_is_enforced_while_streaming() {
        let keys = keys();
        let mut out = Vec::new();
        // A reader that claims nothing and just goes on: the count stops it.
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                buf.fill(7);
                Ok(buf.len())
            }
        }
        let refused = seal(
            keys.public(),
            &ItemId::random(),
            "FAKE.pdf",
            1,
            Source::Opened,
            Endless,
            &mut out,
            3 * CHUNK as u64,
            &|| false,
        );
        assert_eq!(refused, Err(InboxError::TooLarge));
        // Under the limit, exactly at it, and one byte over it.
        for (len, ok) in [(3 * CHUNK, true), (3 * CHUNK + 1, false)] {
            let mut out = Vec::new();
            let result = seal(
                keys.public(),
                &ItemId::random(),
                "FAKE.pdf",
                1,
                Source::Opened,
                Cursor::new(pdf(len)),
                &mut out,
                3 * CHUNK as u64,
                &|| false,
            );
            assert_eq!(result.is_ok(), ok, "{len}");
        }
        // The limit is never above the format's own, however it is asked.
        let mut out = Vec::new();
        let over = seal(
            keys.public(),
            &ItemId::random(),
            "FAKE.pdf",
            1,
            Source::Opened,
            Endless,
            &mut out,
            u64::MAX,
            &|| false,
        );
        assert_eq!(over, Err(InboxError::TooLarge));
        assert!(out.len() as u64 <= sealed_size(MAX_FILE_BYTES));
    }

    #[test]
    fn empty_cancelled_and_failing_inputs_do_not_seal() {
        let keys = keys();
        let run = |input: Box<dyn Read>, cancelled: bool| {
            let mut out = Vec::new();
            seal(
                keys.public(),
                &ItemId::random(),
                "FAKE.pdf",
                1,
                Source::Shared,
                input,
                &mut out,
                MAX_FILE_BYTES,
                &|| cancelled,
            )
        };
        assert_eq!(run(Box::new(io::empty()), false), Err(InboxError::Empty));
        assert_eq!(
            run(Box::new(Cursor::new(pdf(100))), true),
            Err(InboxError::Cancelled)
        );
        struct Failing;
        impl Read for Failing {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("FAKE bad sector"))
            }
        }
        assert_eq!(
            run(Box::new(Failing), false),
            Err(InboxError::Io(io::ErrorKind::Other))
        );
        // An interrupted read is retried, not failed.
        struct Interrupted(bool, Cursor<Vec<u8>>);
        impl Read for Interrupted {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                self.1.read(buf)
            }
        }
        assert!(run(Box::new(Interrupted(false, Cursor::new(pdf(10)))), false).is_ok());
    }

    #[test]
    fn a_short_or_oversized_file_is_malformed_before_anything_is_read() {
        let keys = keys();
        assert_eq!(
            open_all(&keys, &[0; 10]).map(|_| ()),
            Err(InboxError::Malformed)
        );
        // Another magic, another format, a reserved byte set.
        let sealed = seal_bytes(&keys, &ItemId::random(), "FAKE.pdf", &pdf(100));
        for (place, value) in [(0, b'X'), (8, 2), (12, 1)] {
            let mut changed = sealed.clone();
            changed[place] = value;
            assert_eq!(
                open_all(&keys, &changed).map(|_| ()),
                Err(InboxError::Malformed),
                "{place}"
            );
        }
        assert_eq!(peek_header(&sealed[..10]), None);
        assert_eq!(peek_header(&[0; HEADER_LEN]), None);
    }

    #[test]
    fn only_exactly_named_files_are_items_or_parts() {
        let id = ItemId([0xab; 16]);
        assert_eq!(item_file_name(&id), format!("{}.mcin", "ab".repeat(16)));
        assert_eq!(parse_item_name(&item_file_name(&id)), Some(id));
        assert_eq!(parse_part_name(&part_file_name(&id)), Some(id));
        assert_eq!(parse_item_name(&part_file_name(&id)), None);
        assert_eq!(parse_part_name(&item_file_name(&id)), None);
        let hex32 = "ab".repeat(16);
        let bad_names: Vec<String> = vec![
            String::new(),
            ".mcin".to_string(),
            "ab.mcin".to_string(),
            format!("{}.mcin", "AB".repeat(16)),
            format!("{}.mcin", "ab".repeat(17)),
            format!("{hex32}.mcin "),
            format!("{hex32}.MCIN"),
            format!("../{hex32}.mcin"),
            format!("{hex32}.mcin.part"),
            format!("{}.mcin", "zz".repeat(16)),
            format!("{}\u{e9}.mcin", "a".repeat(31)),
            "inbox.pub".to_string(),
            ".lock".to_string(),
        ];
        for bad in bad_names.iter().map(String::as_str) {
            assert_eq!(parse_item_name(bad), None, "{bad:?}");
            assert_eq!(parse_part_name(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_folder_is_counted_by_one_function_and_part_files_count_as_bytes() {
        let (a, b) = (ItemId([1; 16]), ItemId([2; 16]));
        let (name_a, name_b, part_b) = (item_file_name(&a), item_file_name(&b), part_file_name(&b));
        let entries = [
            (name_a.as_str(), 1000_u64),
            (name_b.as_str(), 2000),
            (part_b.as_str(), 500),
            ("inbox.pub", 32),
            (".lock", 0),
            ("junk.bin", 99_999),
        ];
        assert_eq!(
            usage_of(entries),
            Usage {
                items: 2,
                bytes: 3500
            }
        );
        assert_eq!(usage_of([]), Usage::default());
    }

    #[test]
    fn a_file_is_admitted_only_within_every_cap() {
        let caps = Caps {
            items: 3,
            total_bytes: 10_000_000,
            file_bytes: 2_000_000,
            free_reserve: 1_000_000,
            age_secs: 100,
        };
        let usage = Usage {
            items: 2,
            bytes: 4_000_000,
        };
        let free = 50_000_000;
        assert_eq!(admit(&usage, 1_000_000, free, &caps), Ok(()));
        assert_eq!(
            admit(&usage, 2_000_001, free, &caps),
            Err(Refusal::FileTooLarge)
        );
        assert_eq!(
            admit(&Usage { items: 3, bytes: 0 }, 10, free, &caps),
            Err(Refusal::TooManyItems)
        );
        // The sealed size counts, not just the plaintext.
        let nearly_full = Usage {
            items: 1,
            bytes: 10_000_000 - sealed_size(1_000_000) + 1,
        };
        assert_eq!(
            admit(&nearly_full, 1_000_000, free, &caps),
            Err(Refusal::InboxFull)
        );
        let exactly = Usage {
            items: 1,
            bytes: 10_000_000 - sealed_size(1_000_000),
        };
        assert_eq!(admit(&exactly, 1_000_000, free, &caps), Ok(()));
        // The reserve is kept after sealing.
        assert_eq!(
            admit(
                &usage,
                1_000_000,
                1_000_000 + sealed_size(1_000_000) - 1,
                &caps
            ),
            Err(Refusal::NoRoom)
        );
        assert_eq!(
            admit(&usage, 1_000_000, 1_000_000 + sealed_size(1_000_000), &caps),
            Ok(())
        );
        // The shipped caps are the design's.
        assert_eq!(CAPS.items, 100);
        assert_eq!(CAPS.file_bytes, 100 * 1024 * 1024);
        assert_eq!(CAPS.total_bytes, 512 * 1024 * 1024);
        assert_eq!(CAPS.free_reserve, 512 * 1024 * 1024);
        assert_eq!(CAPS.age_secs, 604_800);
    }

    #[test]
    fn expiry_is_by_the_sealed_time_and_the_locked_sweep_waits_twice_as_long() {
        let caps = Caps {
            age_secs: 100,
            ..CAPS
        };
        assert!(!expired(1000, 1099, &caps));
        assert!(expired(1000, 1100, &caps));
        // A time in the future (a clock set back) is not expired.
        assert!(!expired(2000, 1000, &caps));
        assert!(!long_expired(1000, 1199, &caps));
        assert!(long_expired(1000, 1200, &caps));
    }

    // ----- known answers (computed independently: RFC 5869 HKDF-SHA256, RFC 9180 DeriveKeyPair for
    // DHKEM(X25519, HKDF-SHA256), RFC 7748 X25519, in plain Python) -----

    #[test]
    fn the_derived_key_and_ids_are_the_known_answers() {
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let keys = keys();
        assert_eq!(
            hex(&keys.public().to_bytes()),
            "6f905ea21bdf957bbb44f8f8daeda29ea78b6424610ab85c431324f8c7390339"
        );
        assert_eq!(
            hex(&keys.public().key_id().0),
            "fc791c212298fa7fa52250bbd43f50f7"
        );
        assert_eq!(
            keys.record_id(&ItemId([1; 16])).to_string(),
            "e5fb5d03-4fd7-4e37-bf7e-1740045d80b8"
        );
        assert_eq!(
            keys.record_id(&ItemId([2; 16])).to_string(),
            "02b22196-c521-4c72-aec3-2790981f1ee5"
        );
    }

    /// RFC 9180 Appendix A.2 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base
    /// mode), the RFC's own vector (from the CFRG test-vector file the `hpke` crate ships): the
    /// recipient pair from `DeriveKeyPair`, the encapsulated key from the ephemeral key material,
    /// and the exports the sealer takes its keys from. Without it the tests above check the code
    /// only against itself.
    #[test]
    fn the_hpke_suite_matches_the_rfc_9180_appendix_a_2_vector() {
        struct Fixed(Vec<u8>);
        impl hpke::rand_core::RngCore for Fixed {
            fn next_u32(&mut self) -> u32 {
                unreachable!("the ephemeral key needs bytes only")
            }
            fn next_u64(&mut self) -> u64 {
                unreachable!("the ephemeral key needs bytes only")
            }
            fn fill_bytes(&mut self, bytes: &mut [u8]) {
                bytes.copy_from_slice(&self.0[..bytes.len()]);
            }
        }
        impl hpke::rand_core::CryptoRng for Fixed {}
        let unhex = |text: &str| -> Vec<u8> {
            (0..text.len() / 2)
                .map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).unwrap())
                .collect()
        };
        let info = unhex("4f6465206f6e2061204772656369616e2055726e");
        let ikm_e = unhex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b");
        let ikm_r = unhex("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df");
        let sk_r = unhex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb");
        let pk_r = unhex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a");
        let enc = unhex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
        let exports = [
            (
                "",
                "4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e",
            ),
            (
                "00",
                "8c1df14732580e5501b00f82b10a1647b40713191b7c1240ac80e2b68808ba69",
            ),
            (
                "54657374436f6e74657874",
                "5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53",
            ),
        ];

        // DeriveKeyPair, as the inbox key uses it.
        let (private, public) = K::derive_keypair(&ikm_r);
        assert_eq!(private.to_bytes().as_slice(), sk_r.as_slice());
        assert_eq!(public.to_bytes().as_slice(), pk_r.as_slice());

        // The sender with the vector's ephemeral key material.
        let (sent, sender) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, K, _>(
            &OpModeS::Base,
            &public,
            &info,
            &mut Fixed(ikm_e),
        )
        .unwrap();
        assert_eq!(sent.to_bytes().as_slice(), enc.as_slice());
        // The receiver from that encapsulated key.
        let receiver = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, K>(
            &OpModeR::Base,
            &private,
            &sent,
            &info,
        )
        .unwrap();
        for (context, expected) in exports {
            let (context, expected) = (unhex(context), unhex(expected));
            let mut from_sender = vec![0_u8; expected.len()];
            let mut from_receiver = vec![0_u8; expected.len()];
            sender.export(&context, &mut from_sender).unwrap();
            receiver.export(&context, &mut from_receiver).unwrap();
            assert_eq!(from_sender, expected);
            assert_eq!(from_receiver, expected);
        }
    }

    // ----- the opener's refusals of trailers no real sealer writes -----

    /// An item whose trailer holds exactly `plain` (a valid seal otherwise), for `size` bytes of body.
    fn item_with_trailer(keys: &InboxKeys, id: &ItemId, size: usize, plain: Vec<u8>) -> Vec<u8> {
        let mut out = Vec::new();
        seal_with_trailer(
            keys.public(),
            id,
            Cursor::new(pdf(size)),
            &mut out,
            MAX_FILE_BYTES,
            &|| false,
            &mut |_| Zeroizing::new(plain.clone()),
        )
        .unwrap();
        out
    }

    fn meta_bytes(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let mut plain = encode_meta(&ItemMeta {
            name: "FAKE.pdf".into(),
            received_at: 1_792_454_400,
            source: Source::Shared,
            plaintext_size: 2000,
        })
        .to_vec();
        f(&mut plain);
        plain
    }

    #[test]
    fn a_trailer_no_sealer_would_write_is_refused() {
        let keys = keys();
        let id = ItemId([9; 16]);
        // The right trailer for a 2 000-byte body opens.
        let good = item_with_trailer(&keys, &id, 2000, meta_bytes(|_| {}));
        assert!(open_with_id(&keys, &id, &good).is_ok());
        let name_at = META_NAME_AT;
        let refused: Vec<(&str, Vec<u8>, InboxError)> = vec![
            (
                "another version",
                meta_bytes(|p| p[0] = 2),
                InboxError::Malformed,
            ),
            (
                "a name longer than the bound",
                meta_bytes(|p| p[1..3].copy_from_slice(&((NAME_MAX + 1) as u16).to_be_bytes())),
                InboxError::Malformed,
            ),
            (
                "padding after the name that is not zero",
                meta_bytes(|p| p[name_at + 100] = 1),
                InboxError::Malformed,
            ),
            (
                "a name that is not UTF-8",
                meta_bytes(|p| {
                    p[1..3].copy_from_slice(&2_u16.to_be_bytes());
                    p[name_at] = 0xff;
                    p[name_at + 1] = 0xfe;
                    for byte in &mut p[name_at + 2..name_at + 8] {
                        *byte = 0;
                    }
                }),
                InboxError::Malformed,
            ),
            (
                "an unknown source",
                meta_bytes(|p| p[19] = 7),
                InboxError::Malformed,
            ),
            (
                "a size that is not the body's",
                meta_bytes(|p| p[11..19].copy_from_slice(&1999_u64.to_be_bytes())),
                InboxError::Tampered,
            ),
            (
                "a size of zero",
                meta_bytes(|p| p[11..19].copy_from_slice(&0_u64.to_be_bytes())),
                InboxError::Tampered,
            ),
            (
                "a size past the format's limit",
                meta_bytes(|p| p[11..19].copy_from_slice(&(MAX_FILE_BYTES + 1).to_be_bytes())),
                InboxError::Tampered,
            ),
            (
                "a trailer that is not the fixed size",
                meta_bytes(|p| p.truncate(META_PLAIN - 1)),
                // The file's length no longer fits any body, so the trailer is read from the wrong place.
                InboxError::Tampered,
            ),
        ];
        for (what, plain, expected) in refused {
            let item = item_with_trailer(&keys, &id, 2000, plain);
            assert_eq!(
                open_with_id(&keys, &id, &item).map(|_| ()),
                Err(expected),
                "{what}"
            );
        }
    }

    #[test]
    fn an_item_is_refused_under_another_names_id() {
        let keys = keys();
        let id = ItemId([3; 16]);
        let sealed = seal_bytes(&keys, &id, "FAKE.pdf", &pdf(500));
        assert!(open_with_id(&keys, &id, &sealed).is_ok());
        assert_eq!(
            open_with_id(&keys, &ItemId([4; 16]), &sealed).map(|_| ()),
            Err(InboxError::Tampered)
        );
    }

    #[test]
    fn a_low_order_encapsulated_key_is_refused_and_each_seal_has_its_own() {
        let keys = keys();
        let id = ItemId([5; 16]);
        let sealed = seal_bytes(&keys, &id, "FAKE.pdf", &pdf(500));
        let again = seal_bytes(&keys, &id, "FAKE.pdf", &pdf(500));
        assert_ne!(
            sealed[48..80],
            again[48..80],
            "two seals shared an ephemeral key"
        );
        for point in [[0_u8; 32], {
            let mut one = [0_u8; 32];
            one[0] = 1;
            one
        }] {
            let mut forged = sealed.clone();
            forged[48..80].copy_from_slice(&point);
            assert_eq!(
                open_with_id(&keys, &id, &forged).map(|_| ()),
                Err(InboxError::Tampered)
            );
        }
    }

    #[test]
    fn a_non_canonical_public_key_is_refused() {
        let good = keys().public().to_bytes();
        let mut high = good;
        high[31] |= 0x80;
        assert_eq!(
            InboxPublic::from_bytes(&high),
            Err(InboxError::BadPublicKey)
        );
        // 2^255 - 19 and above (the low-order list holds p, p + 1 already).
        let mut at_p = [0xff_u8; 32];
        at_p[0] = 0xed;
        at_p[31] = 0x7f;
        assert!(!is_canonical_x25519(&at_p));
        at_p[0] = 0xec;
        assert!(is_canonical_x25519(&at_p));
        assert!(is_canonical_x25519(&good));
    }

    #[test]
    fn a_time_far_ahead_of_the_clock_is_not_believed() {
        let caps = Caps {
            age_secs: 100,
            ..CAPS
        };
        let now = 1_000_000;
        assert_eq!(age_of(now, now, &caps), Age::Fresh);
        assert_eq!(age_of(now - 99, now, &caps), Age::Fresh);
        assert_eq!(age_of(now - 100, now, &caps), Age::Expired);
        // A little ahead (clocks differ) is fine; past the slack it is not.
        assert_eq!(age_of(now + FUTURE_SLACK_SECS, now, &caps), Age::Fresh);
        assert_eq!(
            age_of(now + FUTURE_SLACK_SECS + 1, now, &caps),
            Age::FromTheFuture
        );
        assert_eq!(age_of(u64::MAX, now, &caps), Age::FromTheFuture);
    }

    #[test]
    fn one_limit_feeds_the_admission_and_the_sealer() {
        let tight = Caps {
            file_bytes: 1000,
            ..CAPS
        };
        assert_eq!(file_limit(&tight), 1000);
        assert_eq!(file_limit(&CAPS), MAX_FILE_BYTES);
        // Caps above the format's own limit are clamped to it.
        let loose = Caps {
            file_bytes: u64::MAX,
            ..CAPS
        };
        assert_eq!(file_limit(&loose), MAX_FILE_BYTES);
        assert_eq!(
            admit(&Usage::default(), 1001, u64::MAX, &tight),
            Err(Refusal::FileTooLarge)
        );
        assert_eq!(admit(&Usage::default(), 1000, u64::MAX, &tight), Ok(()));
        assert_eq!(
            admit(&Usage::default(), MAX_FILE_BYTES + 1, u64::MAX, &loose),
            Err(Refusal::FileTooLarge)
        );
        // The same number as the PDF helper's.
        assert_eq!(
            MAX_FILE_BYTES,
            crate::pdf_unlock::MAX_LOCKED_PDF_BYTES as u64
        );
    }
}
