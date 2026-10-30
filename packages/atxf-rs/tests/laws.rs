//! The converter laws (SPEC §11.1), integrity and reconciliation, on the repository's fixtures and examples.
//!
//! Generated cases run through both implementations in `scripts/cross-check-generated.ts`, which requires the
//! same bytes from both; these tests hold the laws for the Rust crate on its own.

use std::path::{Path, PathBuf};

use atxf::equivalence::{conversation_view, format_view};
use atxf::integrity::{add_integrity, prove_inclusion, verify_inclusion, verify_integrity};
use atxf::json::Value;
use atxf::reconcile::{in_sync, reconcile};
use atxf::transcript::Record;
use atxf::{Severity, Transcript, formats, parse_transcript, serialize_transcript, validate_transcript};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &str) -> String {
    std::fs::read_to_string(repo().join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

const FIXTURES: [(&str, &str); 4] = [
    ("claude-code", "fixtures/claude-code/harbor-hello.jsonl"),
    ("codex", "fixtures/codex/rollout-hand-built.jsonl"),
    ("gemini-cli", "fixtures/gemini-cli/session-hand-built.jsonl"),
    ("opencode", "fixtures/opencode/export-hand-built.json"),
];

fn examples() -> Vec<(String, Transcript)> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(repo().join("examples"))
        .expect("examples/")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.to_string_lossy().ends_with(".atxf.jsonl"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).expect("example");
            (p.file_name().unwrap().to_string_lossy().into_owned(), parse_transcript(&text).expect("example parses"))
        })
        .collect()
}

fn errors(text: &str) -> Vec<String> {
    validate_transcript(text)
        .diagnostics
        .into_iter()
        .filter(|d| d.severity == Severity::Error)
        .map(|d| format!("{}: {}", d.line, d.message))
        .collect()
}

/// A transcript without hashes and seals, for comparing content.
fn unsealed(transcript: &Transcript) -> Transcript {
    let mut header = atxf::integrity::without_hash(&transcript.header);
    header.shift_remove("integrity");
    Transcript { header, records: transcript.records.iter().filter(|r| r.kind() != "seal").map(atxf::integrity::without_hash).collect() }
}

#[test]
fn examples_are_valid() {
    for (name, transcript) in examples() {
        assert_eq!(errors(&serialize_transcript(&transcript)), Vec::<String>::new(), "{name}");
    }
}

#[test]
fn fixtures_round_trip_byte_for_byte_and_decode_to_valid_transcripts() {
    for (agent, path) in FIXTURES {
        let format = formats::by_agent(agent).expect("agent");
        let text = read(path);
        let transcript = format.to_atxf(&text, true).expect("decodes");
        assert_eq!(format.from_atxf(&transcript, true).expect("encodes"), text, "{path}");
        assert_eq!(errors(&serialize_transcript(&transcript)), Vec::<String>::new(), "{path}");
    }
}

#[test]
fn carry_restores_any_transcript_through_any_format() {
    for (name, transcript) in examples() {
        for format in formats::all() {
            let native = format.from_atxf(&transcript, true).expect("encodes");
            let back = format.to_atxf(&native, true).expect("decodes");
            assert_eq!(unsealed(&back), unsealed(&transcript), "{name} through {}", format.agent());
        }
    }
}

#[test]
fn without_carry_the_file_still_holds_the_same_conversation() {
    let mut transcripts = examples();
    for (agent, path) in FIXTURES {
        transcripts.push((path.to_string(), formats::by_agent(agent).unwrap().to_atxf(&read(path), false).unwrap()));
    }
    for (name, transcript) in transcripts {
        for format in formats::all() {
            let written = format.to_atxf(&format.from_atxf(&transcript, false).expect("encodes"), false).expect("decodes");
            let view = |t: &Transcript| format_view(format.agent(), conversation_view(t, false));
            assert_eq!(view(&written), view(&transcript), "{name} through {}", format.agent());
        }
    }
}

#[test]
fn hashes_verify_and_tampering_is_found() {
    for (name, transcript) in examples() {
        let sealed = add_integrity(&transcript, None).expect("hashes");
        assert_eq!(verify_integrity(&sealed), vec![], "{name}");
        let Some(index) = sealed.records.iter().position(|r| r.kind() == "message") else { continue };
        let mut tampered = sealed.clone();
        tampered.records[index].insert("time".into(), Value::String("2000-01-01T00:00:00Z".into()));
        assert!(!verify_integrity(&tampered).is_empty(), "{name}: a changed record must not verify");
    }
}

#[test]
fn inclusion_proofs_verify_for_every_record_of_a_sealed_example() {
    let text = read("examples/sealed.atxf.jsonl");
    let sealed = parse_transcript(&text).unwrap();
    assert_eq!(verify_integrity(&sealed), vec![]);
    for record in sealed.records.iter().filter(|r| r.kind() != "seal") {
        let proof = prove_inclusion(&sealed, record.id()).expect("proof");
        assert!(verify_inclusion(&proof), "{}", record.id());
    }
}

/// The copies of a transcript a session would leave on two machines: a shared prefix, then each one's own records.
fn diverged(transcript: &Transcript) -> (Transcript, Transcript) {
    let cut = transcript.records.len() / 2;
    let a = Transcript { header: transcript.header.clone(), records: transcript.records.clone() };
    let mut b = Transcript { header: transcript.header.clone(), records: transcript.records[..cut].to_vec() };
    let parent = b.records.iter().rev().find(|r| r.is_tree()).map(|r| Value::String(r.id().to_string())).unwrap_or(Value::Null);
    let other = serde_json::json!({ "type": "message", "id": "other-1", "parentId": parent, "time": "2030-01-01T00:00:00Z", "role": "user", "content": "elsewhere" });
    b.records.push(other.as_object().unwrap().clone());
    (unsealed(&a), unsealed(&b))
}

#[test]
fn reconciling_keeps_every_record_once_whatever_the_order() {
    for (name, transcript) in examples() {
        let (a, b) = diverged(&transcript);
        let ab = reconcile(&[a.clone(), b.clone()], None).expect("reconciles");
        let ba = reconcile(&[b.clone(), a.clone()], None).expect("reconciles");
        assert_eq!(serialize_transcript(&ab.transcript), serialize_transcript(&ba.transcript), "{name}: commutative");
        let again = reconcile(&[ab.transcript.clone(), a.clone()], None).expect("reconciles");
        assert!(in_sync(&again.transcript, &ab.transcript).unwrap(), "{name}: idempotent");
        let keys = atxf::reconcile::reconciliation_keys(&ab.transcript).unwrap();
        for copy in [&a, &b] {
            assert!(atxf::reconcile::reconciliation_keys(copy).unwrap().is_subset(&keys), "{name}: no record is lost");
        }
        assert_eq!(errors(&serialize_transcript(&ab.transcript)), Vec::<String>::new(), "{name}: valid");
    }
}

#[test]
fn reconciling_sealed_copies_seals_the_result() {
    let sealed = parse_transcript(&read("examples/sealed.atxf.jsonl")).unwrap();
    let result = reconcile(&[sealed.clone(), sealed], None).unwrap();
    assert!(result.problems.is_empty());
    assert_eq!(verify_integrity(&result.transcript), vec![]);
    assert!(result.transcript.records.iter().any(|r| r.kind() == "seal" && r.id().starts_with("seal~")));
}

#[test]
fn canonical_json_orders_integer_like_keys_as_strings() {
    let value: Value = serde_json::from_str(r#"{"b":1,"4":null,"":"","a":[{"z":1,"10":2}],"n":1e21}"#).unwrap();
    assert_eq!(atxf::canonical::canonical_json(&value), r#"{"":"","4":null,"a":[{"10":2,"z":1}],"b":1,"n":1e+21}"#);
}
