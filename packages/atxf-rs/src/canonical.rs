//! RFC 8785 (JCS) canonical JSON and SHA-256.

use sha2::{Digest, Sha256};

use crate::json::{Map, Value, cmp_utf16, number_to_string, write_string};

/// RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and
/// string serialization. Non-finite numbers cannot occur in parsed JSON.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value);
    out
}

/// Appends the canonical JSON of `value` to `out`.
pub fn write_canonical(out: &mut String, value: &Value) {
    write(out, value);
}

/// Appends the canonical JSON of the object `map` without its key `skip`, as if that key were removed first.
pub fn write_canonical_object_without(out: &mut String, map: &Map, skip: &str) {
    write_object(out, map, Some(skip));
}

fn write(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_object(out, map, None),
    }
}

fn write_object(out: &mut String, map: &Map, skip: Option<&str>) {
    let mut entries: Vec<(&String, &Value)> = map.iter().filter(|(key, _)| Some(key.as_str()) != skip).collect();
    entries.sort_by(|(a, _), (b, _)| cmp_utf16(a, b));
    out.push('{');
    for (i, (key, value)) in entries.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write(out, value);
    }
    out.push('}');
}

/// Lowercase hex SHA-256 of the UTF-8 bytes of `text`.
pub fn sha256(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0xf)]));
    }
    hex
}
