//! Timestamps as JavaScript reads and writes them.
//!
//! ATXF times are RFC 3339 strings. [`parse`] reproduces `Date.parse` for them, including its leniency: a day up
//! to 31 in any month (rolling over into the next), `24:00:00`, any number of fraction digits (truncated to
//! milliseconds) and lowercase `t` and `z`. Other strings are not times here; `Date.parse` would accept some.

use crate::json::{Value, as_f64};

/// The Unix epoch, the time of last resort for a record with none.
pub const EPOCH: &str = "1970-01-01T00:00:00.000Z";

struct Parts<'a> {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    fraction: &'a str,
    offset_minutes: Option<i64>,
}

fn digits(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

/// Splits `YYYY-MM-DDTHH:MM:SS(.F+)?(Z|±HH:MM)`; `None` when the shape is wrong.
fn split(s: &str) -> Option<Parts<'_>> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let mut rest = &s[19..];
    let mut fraction = "";
    if let Some(after) = rest.strip_prefix('.') {
        let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
        if end == 0 {
            return None;
        }
        fraction = &after[..end];
        rest = &after[end..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => None,
        _ => {
            let r = rest.as_bytes();
            if r.len() != 6 || !matches!(r[0], b'+' | b'-') || r[3] != b':' {
                return None;
            }
            let (h, m) = (digits(&rest[1..3])?, digits(&rest[4..6])?);
            if h > 23 || m > 59 {
                return None;
            }
            let sign = if r[0] == b'-' { -1 } else { 1 };
            Some(sign * (h * 60 + m))
        }
    };
    Some(Parts {
        year: digits(&s[0..4])?,
        month: digits(&s[5..7])?,
        day: digits(&s[8..10])?,
        hour: digits(&s[11..13])?,
        minute: digits(&s[14..16])?,
        second: digits(&s[17..19])?,
        fraction,
        offset_minutes,
    })
}

/// Whether `s` has the shape of an RFC 3339 timestamp (`isoTime`'s pattern in the TypeScript implementation).
pub fn is_rfc3339_shape(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 {
        return false;
    }
    let num = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(num(0..4)
        && b[4] == b'-'
        && num(5..7)
        && b[7] == b'-'
        && num(8..10)
        && matches!(b[10], b'T' | b't')
        && num(11..13)
        && b[13] == b':'
        && num(14..16)
        && b[16] == b':'
        && num(17..19))
    {
        return false;
    }
    let mut rest = &s[19..];
    if let Some(after) = rest.strip_prefix('.') {
        let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
        if end == 0 {
            return false;
        }
        rest = &after[end..];
    }
    match rest {
        "Z" | "z" => true,
        _ => {
            let r = rest.as_bytes();
            r.len() == 6
                && matches!(r[0], b'+' | b'-')
                && r[1..3].iter().all(u8::is_ascii_digit)
                && r[3] == b':'
                && r[4..6].iter().all(u8::is_ascii_digit)
        }
    }
}

/// Days from 1970-01-01 to the given proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `Date.parse(s)` for an RFC 3339 timestamp, in milliseconds since the epoch.
pub fn parse(s: &str) -> Option<f64> {
    let p = split(s)?;
    let fraction_zero = p.fraction.bytes().all(|b| b == b'0');
    let valid = (1..=12).contains(&p.month)
        && (1..=31).contains(&p.day)
        && (p.hour < 24 || (p.hour == 24 && p.minute == 0 && p.second == 0 && fraction_zero))
        && p.minute < 60
        && p.second < 60;
    if !valid {
        return None;
    }
    let mut ms_digits = p.fraction.chars().take(3).collect::<String>();
    while ms_digits.len() < 3 {
        ms_digits.push('0');
    }
    let ms: i64 = ms_digits.parse().unwrap_or(0);
    let days = days_from_civil(p.year, p.month, 1) + p.day - 1;
    let total = days * 86_400_000 + p.hour * 3_600_000 + p.minute * 60_000 + p.second * 1000 + ms - p.offset_minutes.unwrap_or(0) * 60_000;
    Some(total as f64)
}

/// `new Date(ms).toISOString()` for a time within years 0 to 9999.
pub fn iso_from_millis(ms: f64) -> String {
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// `Date.parse(iso)`, or 0 when it is not a time (`millisFromIso`).
pub fn millis_from_iso(iso: &str) -> f64 {
    parse(iso).unwrap_or(0.0)
}

/// `value` when it is an RFC 3339 timestamp, a number of milliseconds as one (years 1970 to 9999), otherwise
/// `fallback` (`isoTime`).
pub fn iso_time(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(s)) if is_rfc3339_shape(s) && parse(s).is_some() => s.clone(),
        Some(v @ Value::Number(_)) => {
            let n = as_f64(v).unwrap_or(f64::NAN);
            // `new Date(n)` clips to ±8.64e15 ms and truncates toward zero.
            if n.is_finite() && n.abs() <= 8.64e15 {
                let t = n.trunc();
                let year = civil_from_days((t as i64).div_euclid(86_400_000)).0;
                if (1970..10000).contains(&year) {
                    return iso_from_millis(t);
                }
            }
            fallback.to_string()
        }
        _ => fallback.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_date_parse() {
        let cases: &[(&str, Option<f64>)] = &[
            ("2026-10-30T09:00:00Z", Some(1793350800000.0)),
            ("2026-10-30t09:00:00z", Some(1793350800000.0)),
            ("2026-10-30T09:00:00.1Z", Some(1793350800100.0)),
            ("2026-10-30T09:00:00.123456789Z", Some(1793350800123.0)),
            ("2026-10-30T09:00:00+05:30", Some(1793331000000.0)),
            ("2026-02-31T00:00:00Z", Some(1772496000000.0)),
            ("2026-13-01T00:00:00Z", None),
            ("2026-10-30T24:00:00Z", Some(1793404800000.0)),
            ("2026-10-30T24:30:00Z", None),
            ("2026-10-30T23:60:00Z", None),
            ("0000-01-01T00:00:00Z", Some(-62167219200000.0)),
            ("2026-10-30T09:00:00.Z", None),
            ("2026-10-30T09:00:00+24:00", None),
            ("2026-10-30T09:00:00+23:59", Some(1793264460000.0)),
            ("1969-12-31T23:59:59.9999Z", Some(-1.0)),
            ("2026-10-00T00:00:00Z", None),
        ];
        for (s, expected) in cases {
            assert_eq!(parse(s), *expected, "{s}");
        }
    }

    #[test]
    fn writes_iso_strings() {
        assert_eq!(iso_from_millis(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1793350800000.0), "2026-10-30T09:00:00.000Z");
        assert_eq!(iso_from_millis(253402300799999.0), "9999-12-31T23:59:59.999Z");
        assert_eq!(iso_time(Some(&crate::json::number(1.5)), "x"), "1970-01-01T00:00:00.001Z");
        assert_eq!(iso_time(Some(&crate::json::number(-1.0)), "x"), "x");
        assert_eq!(iso_time(Some(&crate::json::number(1e20)), "x"), "x");
    }
}
