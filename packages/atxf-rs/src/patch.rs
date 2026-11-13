//! JSON Patch (RFC 6902) between JSON values, as converters use it to keep what a native record holds beyond the
//! ATXF fields it maps to (SPEC §11.2). The same algorithm as `patch.ts`, so both write the same patches: objects
//! key by key in UTF-16 code unit order of the keys, arrays of one length element by element, anything else
//! replaced whole, using only `add`, `replace` and `remove`.

use crate::json::{Map, Obj, Value, as_f64, cmp_utf16};

/// Whether two JSON values are equal as JavaScript sees them: numbers as doubles, objects ignoring key order.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => as_f64(a) == as_f64(b),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_equal(a, b)),
        (Value::Object(x), Value::Object(y)) if same_keys(x, y) => x.values().zip(y.values()).all(|(a, b)| json_equal(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_equal(v, w))),
        _ => a == b,
    }
}

/// Whether two objects hold the same keys in the same order: then they compare value by value, without lookups.
fn same_keys(x: &Map, y: &Map) -> bool {
    x.len() == y.len() && x.keys().zip(y.keys()).all(|(a, b)| a == b)
}

fn escape(token: &str) -> std::borrow::Cow<'_, str> {
    if token.contains(['~', '/']) { token.replace('~', "~0").replace('/', "~1").into() } else { token.into() }
}

fn unescape(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

/// The patch that turns `from` into `to`, as JSON objects (`{op, path, value}`). Empty when they are equal.
pub fn diff(to: &Value, from: &Value) -> Vec<Value> {
    let mut ops = Vec::new();
    walk(to, from, &mut String::new(), &mut ops);
    ops
}

fn op(kind: &str, path: &str, value: Option<&Value>) -> Value {
    Obj::new().set("op", kind).set("path", path).opt("value", value.cloned()).value()
}

// One pass: equal subtrees add no operations, so nothing is compared twice. `path` is the pointer so far, grown and
// cut back as the walk goes, so no path is built for a value that is equal.
fn walk(to: &Value, from: &Value, path: &mut String, ops: &mut Vec<Value>) {
    let at = path.len();
    match (to, from) {
        (Value::Object(t), Value::Object(f)) if same_keys(t, f) => {
            // The common case, a record written back with its keys in place: only the keys whose values differ are
            // sorted and walked, in the same order as the general case.
            let mut differing: Vec<(&String, &Value, &Value)> =
                t.iter().zip(f.values()).filter(|((_, a), b)| !json_equal(a, b)).map(|((k, a), b)| (k, a, b)).collect();
            differing.sort_by(|a, b| cmp_utf16(a.0, b.0));
            for (key, a, b) in differing {
                path.push('/');
                path.push_str(&escape(key));
                walk(a, b, path, ops);
                path.truncate(at);
            }
        }
        (Value::Object(t), Value::Object(f)) => {
            let mut keys: Vec<&String> = t.keys().chain(f.keys().filter(|k| !t.contains_key(*k))).collect();
            keys.sort_by(|a, b| cmp_utf16(a, b));
            for key in keys {
                path.push('/');
                path.push_str(&escape(key));
                match (t.get(key), f.get(key)) {
                    (None, _) => ops.push(op("remove", path, None)),
                    (Some(value), None) => ops.push(op("add", path, Some(value))),
                    (Some(a), Some(b)) => walk(a, b, path, ops),
                }
                path.truncate(at);
            }
        }
        (Value::Array(t), Value::Array(f)) if t.len() == f.len() => {
            for (index, (a, b)) in t.iter().zip(f).enumerate() {
                path.push('/');
                path.push_str(&index.to_string());
                walk(a, b, path, ops);
                path.truncate(at);
            }
        }
        _ if json_equal(to, from) => {}
        _ => ops.push(op("replace", path, Some(to))),
    }
}

/// `value` with `ops` applied, in order; `None` when an operation does not apply.
pub fn apply(value: &Value, ops: &[Value]) -> Option<Value> {
    let mut root = value.clone();
    for operation in ops {
        let operation = operation.as_object()?;
        let kind = operation.get("op")?.as_str()?;
        let path = operation.get("path")?.as_str()?;
        let new = operation.get("value");
        if path.is_empty() {
            if kind == "remove" {
                return None;
            }
            root = new?.clone();
            continue;
        }
        let mut tokens: Vec<String> = path.strip_prefix('/')?.split('/').map(unescape).collect();
        let last = tokens.pop()?;
        let mut parent = &mut root;
        for token in &tokens {
            parent = match parent {
                Value::Array(items) => items.get_mut(index(token)?)?,
                Value::Object(map) => map.get_mut(token)?,
                _ => return None,
            };
        }
        match parent {
            Value::Array(items) => {
                let index = if last == "-" { items.len() } else { index(&last)? };
                match kind {
                    "add" if index <= items.len() => items.insert(index, new?.clone()),
                    "replace" if index < items.len() => items[index] = new?.clone(),
                    "remove" if index < items.len() => {
                        items.remove(index);
                    }
                    _ => return None,
                }
            }
            Value::Object(map) => apply_to_object(map, kind, &last, new)?,
            _ => return None,
        }
    }
    Some(root)
}

/// An array index in a JSON Pointer: digits only.
fn index(token: &str) -> Option<usize> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

fn apply_to_object(map: &mut Map, kind: &str, key: &str, value: Option<&Value>) -> Option<()> {
    match kind {
        "add" => {
            map.insert(key.to_string(), value?.clone());
        }
        "replace" if map.contains_key(key) => {
            map.insert(key.to_string(), value?.clone());
        }
        "remove" if map.contains_key(key) => {
            map.shift_remove(key);
        }
        _ => return None,
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn v(text: &str) -> Value {
        parse(text).unwrap()
    }

    #[test]
    fn diff_then_apply_gives_the_target() {
        let cases = [
            (r#"{"a":1,"b":[1,{"c":2}],"d":null}"#, r#"{"a":1,"b":[1,{"c":3}],"e":true}"#),
            (r#"{"a/b":[1,2]}"#, r#"{"a/b":[1]}"#),
            (r#"[1,2,3]"#, r#"{"x":1}"#),
            (r#"{"n":1}"#, r#"{"n":1.0}"#),
        ];
        for (to, from) in cases {
            let (to, from) = (v(to), v(from));
            assert!(json_equal(&apply(&from, &diff(&to, &from)).unwrap(), &to));
        }
    }

    #[test]
    fn patches_field_by_field_in_key_order() {
        let ops = diff(&v(r#"{"a":1,"b":[1,{"c":2}],"d":null}"#), &v(r#"{"a":1,"b":[1,{"c":3}],"e":true}"#));
        assert_eq!(
            Value::Array(ops),
            v(r#"[{"op":"replace","path":"/b/1/c","value":2},{"op":"add","path":"/d","value":null},{"op":"remove","path":"/e"}]"#)
        );
        assert!(diff(&v(r#"{"n":1}"#), &v(r#"{"n":1.0}"#)).is_empty());
    }
}
