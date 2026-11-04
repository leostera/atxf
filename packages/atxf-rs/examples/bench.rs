//! Times the same pipeline as bench/bench.mjs, in release builds.
//! usage: cargo run --release --example bench -- <pi session.jsonl>...
//! `BENCH_STAGE=<stage>` runs only that stage, for profiling.
use std::hint::black_box;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
use std::time::Instant;

use atxf::context::{BuildContextOptions, build_context};
use atxf::formats::{OPENCODE, PI};
use atxf::integrity::verify_integrity;
use atxf::{Converter, Transcript, parse_transcript, reconcile, serialize_transcript, validate_transcript};

/// A named stage of the pipeline.
type Stage<'a> = (&'static str, Box<dyn Fn() + 'a>);

/// Median milliseconds of `work`, after one warm-up run, over at least 3 runs and about a second.
fn time(work: &dyn Fn()) -> f64 {
    work();
    let mut runs = Vec::new();
    let start = Instant::now();
    while runs.len() < 3 || (start.elapsed().as_secs_f64() < 1.0 && runs.len() < 50) {
        let t0 = Instant::now();
        work();
        runs.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    runs.sort_by(f64::total_cmp);
    runs[runs.len() / 2]
}

fn main() {
    let only = std::env::var("BENCH_STAGE").ok();
    for path in std::env::args().skip(1) {
        let text = std::fs::read_to_string(&path).expect("read");
        let transcript = PI.to_atxf(&text, true).expect("read pi");
        let atxf = serialize_transcript(&transcript);
        let native = OPENCODE.from_atxf(&transcript, true).expect("write opencode");
        let keep = transcript.records.len() * 9 / 10;
        let prefix = Transcript { header: transcript.header.clone(), records: transcript.records[..keep].to_vec() };
        let copies = [transcript.clone(), prefix];
        let file = std::path::Path::new(&path).file_name().unwrap().to_string_lossy().into_owned();
        let stages: Vec<Stage> = vec![
            ("read pi", Box::new(|| drop(black_box(PI.to_atxf(&text, true).unwrap())))),
            ("serialize", Box::new(|| drop(black_box(serialize_transcript(&transcript))))),
            ("parse", Box::new(|| drop(black_box(parse_transcript(&atxf).unwrap())))),
            ("validate", Box::new(|| drop(black_box(validate_transcript(&atxf))))),
            ("verify integrity", Box::new(|| drop(black_box(verify_integrity(&transcript))))),
            ("build context", Box::new(|| drop(black_box(build_context(&transcript, &BuildContextOptions::default()))))),
            ("write opencode", Box::new(|| drop(black_box(OPENCODE.from_atxf(&transcript, true).unwrap())))),
            ("read opencode", Box::new(|| drop(black_box(OPENCODE.to_atxf(&native, true).unwrap())))),
            ("reconcile", Box::new(|| drop(black_box(reconcile(&copies, None).unwrap())))),
        ];
        for (stage, work) in &stages {
            if only.as_deref().is_some_and(|only| only != *stage) {
                continue;
            }
            let ms = time(work.as_ref());
            println!(
                r#"{{"impl":"rust","file":"{file}","bytes":{},"records":{},"stage":"{stage}","ms":{ms:.3}}}"#,
                text.len(),
                transcript.records.len()
            );
        }
    }
}
