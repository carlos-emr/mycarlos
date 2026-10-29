//! Streams an independently encrypted original using the existing MCVO1 format.
//! Its input comes only from `verify_object`, never rendered text or a temporary
//! plaintext file. Keep one pending chunk to authenticate the final-chunk bit.

use super::{
    fail_at_test_boundary, object_aad, open_private_new, terminate_at_test_boundary, ObjectContext,
    VaultError, CHUNK_SIZE, OBJECT_MAGIC,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufWriter, Write},
    path::Path,
};
use zeroize::{Zeroize, Zeroizing};

pub(super) struct OriginalWriter {
    file: BufWriter<File>,
    cipher: XChaCha20Poly1305,
    context: ObjectContext,
    nonce_prefix: [u8; 16],
    buffer: Zeroizing<Vec<u8>>,
    index: u64,
    size: u64,
    sha256: Sha256,
}

impl OriginalWriter {
    pub(super) fn new(
        path: &Path,
        context: ObjectContext,
        key: &[u8; 32],
    ) -> Result<Self, VaultError> {
        let mut file = BufWriter::new(open_private_new(path)?);
        let mut nonce_prefix = [0; 16];
        OsRng.fill_bytes(&mut nonce_prefix);
        file.write_all(OBJECT_MAGIC)?;
        file.write_all(&(CHUNK_SIZE as u32).to_be_bytes())?;
        file.write_all(&nonce_prefix)?;
        Ok(Self {
            file,
            cipher: XChaCha20Poly1305::new(key.into()),
            context,
            nonce_prefix,
            buffer: Zeroizing::new(Vec::with_capacity(CHUNK_SIZE)),
            index: 0,
            size: 0,
            sha256: Sha256::new(),
        })
    }

    fn chunk(&mut self, final_chunk: bool) -> io::Result<()> {
        let mut nonce = [0; 24];
        nonce[..16].copy_from_slice(&self.nonce_prefix);
        nonce[16..].copy_from_slice(&self.index.to_be_bytes());
        let aad = object_aad(
            self.context.vault_id,
            self.context.record_id,
            self.index,
            final_chunk,
        );
        let ciphertext = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &self.buffer,
                    aad: &aad,
                },
            )
            .map_err(|_| io::Error::other("original encryption failed"))?;
        self.file
            .write_all(&(ciphertext.len() as u32).to_be_bytes())?;
        self.file.write_all(&[u8::from(final_chunk)])?;
        self.file.write_all(&ciphertext)?;
        self.buffer.zeroize();
        self.buffer.clear();
        terminate_at_test_boundary("original.after-chunk-write");
        fail_at_test_boundary("original.after-chunk-write")
            .map_err(|_| io::Error::from(io::ErrorKind::StorageFull))?;
        if !final_chunk {
            self.index = self
                .index
                .checked_add(1)
                .ok_or_else(|| io::Error::other("original is too large"))?;
        }
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<(u64, String), VaultError> {
        self.chunk(true)?;
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        let digest = self.sha256.finalize();
        Ok((
            self.size,
            digest.iter().map(|b| format!("{b:02x}")).collect(),
        ))
    }
}

impl Write for OriginalWriter {
    fn write(&mut self, mut input: &[u8]) -> io::Result<usize> {
        let count = input.len();
        self.size = self
            .size
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("original is too large"))?;
        self.sha256.update(input);
        while !input.is_empty() {
            if self.buffer.len() == CHUNK_SIZE {
                self.chunk(false)?;
            }
            let take = input.len().min(CHUNK_SIZE - self.buffer.len());
            self.buffer.extend_from_slice(&input[..take]);
            input = &input[take..];
        }
        Ok(count)
    }

    // verify_object flushes after authenticating the last input chunk. Only
    // finish emits the final output chunk, after its entire input succeeded.
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

pub(super) struct HashWriter<W> {
    output: W,
    sha256: Sha256,
}

impl<W> HashWriter<W> {
    pub(super) fn new(output: W) -> Self {
        Self {
            output,
            sha256: Sha256::new(),
        }
    }
    pub(super) fn digest(&self) -> String {
        self.sha256
            .clone()
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.output.write(bytes)?;
        self.sha256.update(&bytes[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use uuid::Uuid;

    #[test]
    fn original_pdf_stream_writer_uses_existing_format_across_chunk_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        for size in [
            0,
            1,
            CHUNK_SIZE - 1,
            CHUNK_SIZE,
            CHUNK_SIZE + 1,
            CHUNK_SIZE * 2,
        ] {
            let path = temp.path().join(format!("{size}.mcobj"));
            let context = ObjectContext {
                vault_id: Uuid::new_v4(),
                record_id: Uuid::new_v4(),
                profile_id: Uuid::new_v4(),
            };
            let input = vec![0x37; size];
            let mut encrypted = OriginalWriter::new(&path, context, &[7; 32]).unwrap();
            for bytes in input.chunks(777) {
                encrypted.write_all(bytes).unwrap();
            }
            let (length, digest) = encrypted.finish().unwrap();
            assert_eq!(length, size as u64);
            assert_eq!(
                digest,
                Sha256::digest(&input)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            let mut output = Cursor::new(Vec::new());
            super::super::verify_object(
                &path,
                &mut output,
                context.vault_id,
                context.record_id,
                &[7; 32],
                size as u64,
            )
            .unwrap();
            assert_eq!(output.into_inner(), input);
        }
    }
}
