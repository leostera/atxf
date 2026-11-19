//! `atxf`: validate, convert, reconcile and linearize transcripts. The same commands as the TypeScript CLI.

use std::io::Write;
use std::process::ExitCode;

use atxf::{Transcript, formats, linearize, parse_transcript, reconcile, serialize_transcript, validate_transcript};

fn usage() -> ExitCode {
    let agents: Vec<&str> = formats::all().iter().map(|f| f.agent()).collect();
    eprintln!(
        "usage:
  atxf validate <file.atxf.jsonl>...
  atxf convert --from <agent|atxf> --to <agent|atxf> [--no-carry [--tree]] <file>      writes to stdout
  atxf reconcile <copy.atxf.jsonl>...                                           writes to stdout
  atxf linearize [--from <agent|atxf>] [--to <agent|atxf>] <copy>...           every branch on one path, to stdout
      several copies of a session are reconciled first; --to an agent writes its session file
  atxf stream --from <agent> [--no-integrity] [--lines <first>:<last>] [--resume <state.json>] [--state <state.json>] <file>
      pushes the file's lines (1-based, inclusive) one at a time; writes each record, then the header, to stdout

agents: {}",
        agents.join(", ")
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return usage();
    }
    let command = args.remove(0);
    let result = match command.as_str() {
        "validate" => validate(&args),
        "convert" => convert(args),
        "reconcile" => reconcile_command(&args),
        "linearize" => linearize_command(args),
        "stream" => stream_command(args),
        _ => return usage(),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("atxf: {message}");
            ExitCode::FAILURE
        }
    }
}

fn read(file: &str) -> Result<String, String> {
    std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))
}

fn write_stdout(text: &str) -> Result<(), String> {
    std::io::stdout().lock().write_all(text.as_bytes()).map_err(|e| e.to_string())
}

fn validate(files: &[String]) -> Result<ExitCode, String> {
    if files.is_empty() {
        return Ok(usage());
    }
    let mut failed = false;
    for file in files {
        let result = validate_transcript(&read(file)?);
        for d in &result.diagnostics {
            println!("{file}:{}: {}: {}", d.line, d.severity.as_str(), d.message);
        }
        println!("{} {file}", if result.ok { "ok  " } else { "FAIL" });
        failed |= !result.ok;
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

fn convert(mut args: Vec<String>) -> Result<ExitCode, String> {
    let mut option = |name: &str| {
        let at = args.iter().position(|a| a == name)?;
        let taken: Vec<String> = args.drain(at..(at + 2).min(args.len())).collect();
        taken.into_iter().nth(1)
    };
    let from = option("--from");
    let to = option("--to");
    let carry = !args.iter().any(|a| a == "--no-carry");
    let tree = args.iter().any(|a| a == "--tree");
    let file = args.iter().find(|a| *a != "--no-carry" && *a != "--tree");
    let known = |name: &Option<String>| name.as_deref().is_some_and(|n| n == "atxf" || formats::by_agent(n).is_some());
    let (true, true, Some(file)) = (known(&from), known(&to), file) else { return Ok(usage()) };
    let (from, to) = (from.unwrap_or_default(), to.unwrap_or_default());
    let text = read(file)?;
    let transcript: Transcript = match formats::by_agent(&from) {
        Some(format) => format.to_atxf(&text, true),
        None => parse_transcript(&text),
    }
    .map_err(|e| e.to_string())?;
    let out = match formats::by_agent(&to) {
        Some(format) => match (carry, tree) {
            (false, true) => match format.from_atxf_tree(&transcript) {
                Some(text) => text,
                None => format.from_atxf(&transcript, false).map_err(|e| e.to_string())?,
            },
            _ => format.from_atxf(&transcript, carry).map_err(|e| e.to_string())?,
        },
        None => serialize_transcript(&transcript),
    };
    write_stdout(&out)?;
    Ok(ExitCode::SUCCESS)
}

fn stream_command(mut args: Vec<String>) -> Result<ExitCode, String> {
    let mut option = |name: &str| {
        let at = args.iter().position(|a| a == name)?;
        let taken: Vec<String> = args.drain(at..(at + 2).min(args.len())).collect();
        taken.into_iter().nth(1)
    };
    let from = option("--from");
    let range = option("--lines");
    let resume = option("--resume");
    let save = option("--state");
    let integrity = !args.iter().any(|a| a == "--no-integrity");
    let file = args.iter().find(|a| *a != "--no-integrity");
    let bounds = match range.as_deref().map(|r| r.split_once(':')) {
        None => Some(None),
        Some(Some((a, b))) if [a, b].iter().all(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())) => {
            a.parse::<usize>().ok().zip(b.parse::<usize>().ok()).map(Some)
        }
        Some(_) => None,
    };
    let (Some("pi"), Some(file), Some(bounds)) = (from.as_deref(), file, bounds) else { return Ok(usage()) };
    let text = read(file)?;
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let (first, last) = bounds.unwrap_or((1, lines.len()));
    let mut stream = match resume {
        None => formats::PiStream::new(integrity),
        Some(path) => {
            let state = atxf::json::parse(&read(&path)?).map_err(|e| format!("{path}: {e}"))?;
            match formats::PiStream::resume(&state) {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("{e}");
                    return Ok(ExitCode::FAILURE);
                }
            }
        }
    };
    let mut out = String::new();
    let (from, to) = (first.saturating_sub(1).min(lines.len()), last.min(lines.len()));
    for line in lines.get(from..to.max(from)).unwrap_or_default() {
        for record in stream.push(line) {
            out.push_str(&atxf::json::stringify(&atxf::json::Value::Object(record)));
            out.push('\n');
        }
    }
    out.push_str(&atxf::json::stringify(&stream.header().cloned().map_or(atxf::json::Value::Null, atxf::json::Value::Object)));
    out.push('\n');
    write_stdout(&out)?;
    if let Some(path) = save {
        std::fs::write(&path, format!("{}\n", atxf::json::stringify(&stream.state()))).map_err(|e| format!("{path}: {e}"))?;
    }
    Ok(ExitCode::SUCCESS)
}

/// Files given together link by path too: a `parent.uri` naming another of the files links to that file's session,
/// whatever the file is called (Pi records its parent's path). As `linkByPath` in `cli.ts`.
fn link_by_path(files: &[String], mut transcripts: Vec<Transcript>) -> Vec<Transcript> {
    let real = |path: &str| std::fs::canonicalize(path).map_or_else(|_| path.to_string(), |p| p.to_string_lossy().into_owned());
    let paths: Vec<String> = files.iter().map(|f| real(f)).collect();
    let ids: Vec<String> = transcripts.iter().map(|t| t.id().to_string()).collect();
    for transcript in &mut transcripts {
        let verified = transcript.header.contains_key("integrity") && atxf::integrity::verify_integrity(transcript).is_empty();
        let Some(parent) = transcript.header.get_mut("parent").and_then(|p| p.as_object_mut()) else { continue };
        let Some(uri) = parent.get("uri").and_then(|u| u.as_str()) else { continue };
        let Some(at) = paths.iter().position(|p| *p == real(uri)) else { continue };
        if parent.get("transcriptId").and_then(|t| t.as_str()) == Some(ids[at].as_str()) {
            continue;
        }
        parent.insert("transcriptId".into(), atxf::json::Value::String(ids[at].clone()));
        // The header is hashed, so a file whose hashes verified is hashed again; one that did not keeps its problems.
        if verified && let Ok(hashed) = atxf::integrity::add_integrity(transcript, None) {
            *transcript = hashed;
        }
    }
    transcripts
}

fn reconcile_command(files: &[String]) -> Result<ExitCode, String> {
    if files.is_empty() {
        return Ok(usage());
    }
    let copies = files.iter().map(|f| parse_transcript(&read(f)?).map_err(|e| format!("{f}: {e}"))).collect::<Result<Vec<_>, _>>()?;
    let copies = link_by_path(files, copies);
    let result = reconcile(&copies, None).map_err(|e| e.to_string())?;
    for (copy, found) in &result.problems {
        for p in found {
            let index = p.index.map_or(0, |i| i + 1);
            eprintln!("{}: record {index}: {}", files[*copy], p.message);
        }
    }
    for r in &result.renamed {
        eprintln!("renamed {} -> {}", r.id, r.as_id);
    }
    write_stdout(&serialize_transcript(&result.transcript))?;
    Ok(if result.problems.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

fn linearize_command(mut args: Vec<String>) -> Result<ExitCode, String> {
    let mut option = |name: &str| {
        let at = args.iter().position(|a| a == name)?;
        let taken: Vec<String> = args.drain(at..(at + 2).min(args.len())).collect();
        taken.into_iter().nth(1)
    };
    let from = option("--from").unwrap_or_else(|| "atxf".into());
    let to = option("--to").unwrap_or_else(|| "atxf".into());
    let known = |name: &str| name == "atxf" || formats::by_agent(name).is_some();
    if !known(&from) || !known(&to) || args.is_empty() {
        return Ok(usage());
    }
    let mut read_copies = Vec::with_capacity(args.len());
    for file in &args {
        let text = read(file)?;
        let copy = match formats::by_agent(&from) {
            Some(format) => format.to_atxf(&text, true),
            None => parse_transcript(&text),
        };
        read_copies.push(copy.map_err(|e| format!("{file}: {e}"))?);
    }
    let mut copies = link_by_path(&args, read_copies);
    let source = if copies.len() > 1 {
        let result = reconcile(&copies, None).map_err(|e| e.to_string())?;
        for (copy, found) in &result.problems {
            for p in found {
                eprintln!("{}: record {}: {}", args[*copy], p.index.map_or(0, |i| i + 1), p.message);
            }
        }
        if !result.problems.is_empty() {
            return Ok(ExitCode::FAILURE);
        }
        result.transcript
    } else {
        copies.remove(0)
    };
    let result = linearize(&source).map_err(|e| e.to_string())?;
    eprintln!("linearized {} branch(es) into one", result.branches);
    let out = match formats::by_agent(&to) {
        Some(format) => match format.from_atxf_tree(&result.transcript) {
            Some(text) => text,
            None => format.from_atxf(&result.transcript, false).map_err(|e| e.to_string())?,
        },
        None => serialize_transcript(&result.transcript),
    };
    write_stdout(&out)?;
    Ok(ExitCode::SUCCESS)
}
