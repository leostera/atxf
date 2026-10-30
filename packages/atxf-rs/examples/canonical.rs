//! Prints the canonical JSON (RFC 8785) of each JSON line on stdin.
use std::io::BufRead;

fn main() {
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        match atxf::json::parse(&line) {
            Ok(value) => println!("{}", atxf::canonical::canonical_json(&value)),
            Err(e) => println!("error: {e}"),
        }
    }
}
