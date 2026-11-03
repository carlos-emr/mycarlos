//! A generation shared by native PDF opens, cancellation and vault locks.
//! It is sent to Swift too, so a cancelled open cannot reappear from its UI queue.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(crate) const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Gate(AtomicU64);

impl Gate {
    pub(crate) fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
}

/// A dismissed or replaced reader cannot postpone either inactivity deadline.
pub(crate) struct ActivityGate {
    generation: u64,
    open: AtomicBool,
}

impl ActivityGate {
    pub(crate) fn new(generation: u64) -> Self {
        Self {
            generation,
            open: AtomicBool::new(true),
        }
    }

    pub(crate) fn accepts(&self, gate: &Gate, event: &str) -> bool {
        if event == "closed" {
            self.open.store(false, Ordering::SeqCst);
        }
        event == "activity" && self.open.load(Ordering::SeqCst) && gate.current(self.generation)
    }
}

#[cfg(target_os = "ios")]
pub(crate) static GATE: Gate = Gate(AtomicU64::new(0));

/// The PDF is decrypted only into a bounded buffer; the renderer receives no bytes.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn prepare(
    store: &crate::vault::VaultStore,
    record_id: uuid::Uuid,
) -> Result<(zeroize::Zeroizing<Vec<u8>>, String), crate::vault::VaultError> {
    use crate::vault::VaultError;
    let snapshot = store.snapshot()?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.id == record_id && record.hidden.is_none())
        .ok_or(VaultError::NotFound)?;
    if record.plaintext_size > MAX_BYTES as u64 {
        return Err(VaultError::PdfMobileTooLarge);
    }
    let mut buffer = crate::LimitedBuffer::new(MAX_BYTES);
    let exported = store.export(record_id, &mut buffer);
    if buffer.over {
        return Err(VaultError::PdfMobileTooLarge);
    }
    exported?;
    // Merely a type guard: the isolated WebKit view must validate the PDF itself.
    if !buffer.bytes.starts_with(b"%PDF-") {
        return Err(VaultError::NotPdf);
    }
    Ok((buffer.bytes, record.display_name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{ImportSource, VaultError, VaultStore};
    use std::io::Cursor;

    fn stored(bytes: Vec<u8>) -> (tempfile::TempDir, VaultStore, uuid::Uuid) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create("river-azimuth-cobalt-sparrow-934", "FAKE Patient", 1)
            .unwrap();
        let person = store.snapshot().unwrap().profiles[0].id;
        let imported = store
            .import(
                person,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE Letter.pdf".to_owned(),
                    reader: Box::new(Cursor::new(bytes)),
                }],
                2,
            )
            .unwrap();
        (temp, store, imported.imported[0])
    }

    #[test]
    fn cancellation_and_a_new_document_invalidate_queued_opens() {
        let gate = Gate::default();
        let old = gate.next();
        assert!(gate.current(old));
        let cancel = gate.next();
        assert!(!gate.current(old));
        let new = gate.next();
        assert!(new > cancel && cancel > old);
        assert!(gate.current(new));
        assert!(!gate.current(cancel));
    }

    #[test]
    fn genuine_activity_stops_on_close_or_request_replacement() {
        let gate = Gate::default();
        let activity = ActivityGate::new(gate.next());
        assert!(activity.accepts(&gate, "activity"));
        assert!(!activity.accepts(&gate, "unknown"));
        assert!(!activity.accepts(&gate, "closed"));
        assert!(!activity.accepts(&gate, "activity"));
        let next = ActivityGate::new(gate.next());
        assert!(next.accepts(&gate, "activity"));
        gate.next();
        assert!(!next.accepts(&gate, "activity"));
    }

    #[test]
    fn prepares_exact_bytes_and_refuses_hidden_and_locked_documents() {
        let bytes = include_bytes!("../../dev-data/FAKE_Avery_Patient_Bloodwork.pdf");
        let (_temp, store, id) = stored(bytes.to_vec());
        let (shown, title) = prepare(&store, id).unwrap();
        assert_eq!(&*shown, bytes);
        assert_eq!(title, "FAKE Letter.pdf");
        store.hide_record(id, 3).unwrap();
        assert!(matches!(prepare(&store, id), Err(VaultError::NotFound)));
        store.lock();
        assert!(matches!(prepare(&store, id), Err(VaultError::Locked)));
    }

    #[test]
    fn refuses_a_pdf_over_the_mobile_memory_budget_before_export() {
        let mut bytes = vec![b' '; MAX_BYTES + 1];
        bytes[..5].copy_from_slice(b"%PDF-");
        let (_temp, store, id) = stored(bytes);
        assert!(matches!(
            prepare(&store, id),
            Err(VaultError::PdfMobileTooLarge)
        ));
    }
}
