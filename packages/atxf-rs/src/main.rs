//! `atxf`: validate, convert and reconcile transcripts. The same commands as the TypeScript CLI.

use std::io::Write;
use std::process::ExitCode;

use atxf::{Transcript, formats, parse_transcript, reconcile, serialize_transcript, validate_transcript};

fn usage() -> ExitCode {
    let agents: Vec<&str> = formats::all().iter().map(|f| f.agent()).collect();
    eprintln!(
        "usage:
  atxf validate <file.atxf.jsonl>...
  atxf convert --from <agent|atxf> --to <agent|atxf> [--no-carry [--tree]] <file>      writes to stdout
  atxf reconcile <copy.atxf.jsonl>...                                           writes to stdout
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

fn reconcile_command(files: &[String]) -> Result<ExitCode, String> {
    if files.is_empty() {
        return Ok(usage());
    }
    let copies = files.iter().map(|f| parse_transcript(&read(f)?).map_err(|e| format!("{f}: {e}"))).collect::<Result<Vec<_>, _>>()?;
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
