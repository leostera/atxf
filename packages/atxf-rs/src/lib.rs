//! ATXF, the Agent Transcript Exchange Format: transcripts of coding-agent sessions as a JSONL tree of records.
//!
//! This crate is a port of the TypeScript implementation (`@leostera/atxf`) and writes the same bytes and hashes:
//!
//! - [`transcript`]: reading and writing `.atxf.jsonl` files.
//! - [`validate`]: the JSON Schema and the cross-record rules of SPEC.md.
//! - [`tree`] and [`context`]: the active path and the context a model sees.
//! - [`integrity`]: Merkle hashes, seals and inclusion proofs.
//! - [`formats`]: lossless converters for Pi, Claude Code, Codex, OpenCode and Gemini CLI.
//! - [`reconcile`]: merging diverged copies of one session.

pub mod canonical;
pub mod codec;
pub mod context;
pub mod equivalence;
pub mod formats;
pub mod integrity;
pub mod json;
pub mod native;
pub mod reconcile;
pub mod time;
pub mod transcript;
pub mod tree;
pub mod validate;

pub use codec::Converter;
pub use reconcile::{ReconcileResult, reconcile};
pub use transcript::{Error, Transcript, parse_transcript, serialize_transcript};
pub use validate::{Diagnostic, Severity, ValidationResult, validate_transcript};
