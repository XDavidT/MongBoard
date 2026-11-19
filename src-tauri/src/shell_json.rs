//! "Shell JSON": the mongosh-flavoured JSON people type into MongoDB tools.
//!
//! Parsing accepts plain JSON plus:
//! - unquoted keys (`{ status: "x" }`) and single-quoted strings
//! - shell constructors: `ObjectId("…")`, `ISODate("…")`, `new Date("…")`,
//!   `NumberInt(…)`, `NumberLong(…)`, `Long(…)`, `Int32(…)`, `Double(…)`,
//!   `NumberDecimal("…")`, `Decimal128("…")`, `Timestamp(t, i)`, `BinData(sub, "b64")`,
//!   `UUID("…")`, `MinKey()`, `MaxKey()`, `RegExp("…", "flags")`, `/pattern/flags`
//! - canonical Extended JSON wrappers (`{"$oid": …}`, `{"$date": …}`, `{"$numberLong": …}` …)
//! - trailing commas and `//` / `/* */` comments
//!
//! Number literals: an integer that fits in 32 bits becomes Int32, a larger one Int64,
//! anything with a decimal point or exponent becomes Double. The writer mirrors this
//! (Double always prints with a decimal point, Int64 prints as `NumberLong(…)`), so
//! documents round-trip without changing types.

use base64::Engine;
use bson::{spec::BinarySubtype, Binary, Bson, DateTime, Decimal128, Document, Regex, Timestamp};
use std::fmt::Write as _;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message} (line {line}, column {column})")]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

/// Parse any shell value.
pub fn parse_value(input: &str) -> Result<Bson, ParseError> {
    let mut p = Parser {
        chars: input.chars().collect(),
        pos: 0,
    };
    p.skip_ws()?;
    let value = p.value()?;
    p.skip_ws()?;
    if p.pos < p.chars.len() {
        return Err(p.err("Unexpected text after the value"));
    }
    Ok(value)
}

/// Parse a shell document (`{ … }`). An empty or whitespace-only input yields `{}`.
pub fn parse_document(input: &str) -> Result<Document, ParseError> {
    if input.trim().is_empty() {
        return Ok(Document::new());
    }
    match parse_value(input)? {
        Bson::Document(d) => Ok(d),
        _ => Err(ParseError {
            message: "Expected a document like { … }".into(),
            line: 1,
            column: 1,
        }),
    }
}

#[allow(dead_code)] // used by the aggregation builder (next milestone)
/// Parse an aggregation pipeline (`[ { … }, … ]`).
pub fn parse_pipeline(input: &str) -> Result<Vec<Document>, ParseError> {
    match parse_value(input)? {
        Bson::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(i, b)| match b {
                Bson::Document(d) => Ok(d),
                _ => Err(ParseError {
                    message: format!("Stage {} is not a document", i + 1),
                    line: 1,
                    column: 1,
                }),
            })
            .collect(),
        Bson::Document(d) => Ok(vec![d]),
        _ => Err(ParseError {
            message: "Expected a pipeline like [ { … } ]".into(),
            line: 1,
            column: 1,
        }),
    }
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn err(&self, message: &str) -> ParseError {
        let mut line = 1;
        let mut column = 1;
        for c in self.chars.iter().take(self.pos) {
            if *c == '\n' {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        ParseError {
            message: message.to_string(),
            line,
            column,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn skip_ws(&mut self) -> Result<(), ParseError> {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => self.pos += 1,
                Some('/') if self.peek_at(1) == Some('/') => {
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.pos += 1;
                    }
                }
                Some('/') if self.peek_at(1) == Some('*') => {
                    self.pos += 2;
                    loop {
                        match self.peek() {
                            None => return Err(self.err("Unterminated /* comment")),
                            Some('*') if self.peek_at(1) == Some('/') => {
                                self.pos += 2;
                                break;
                            }
                            _ => self.pos += 1,
                        }
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn expect(&mut self, c: char) -> Result<(), ParseError> {
        self.skip_ws()?;
        if self.peek() == Some(c) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.err(&format!("Expected '{c}'")))
        }
    }

    fn value(&mut self) -> Result<Bson, ParseError> {
        self.skip_ws()?;
        match self.peek() {
            None => Err(self.err("Unexpected end of input")),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') | Some('\'') => Ok(Bson::String(self.string()?)),
            Some('/') => self.regex_literal(),
            Some(c) if c == '-' || c == '+' || c == '.' || c.is_ascii_digit() => self.number(),
            Some(c) if is_ident_start(c) => self.word(),
            Some(c) => Err(self.err(&format!("Unexpected character '{c}'"))),
        }
    }

    fn object(&mut self) -> Result<Bson, ParseError> {
        self.expect('{')?;
        let mut doc = Document::new();
        loop {
            self.skip_ws()?;
            if self.peek() == Some('}') {
                self.pos += 1;
                break;
            }
            let key = match self.peek() {
                Some('"') | Some('\'') => self.string()?,
                Some(c) if is_ident_start(c) => self.ident(),
                _ => return Err(self.err("Expected a field name")),
            };
            self.expect(':')?;
            let value = self.value()?;
            doc.insert(key, value);
            self.skip_ws()?;
            match self.peek() {
                Some(',') => self.pos += 1,
                Some('}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.err("Expected ',' or '}'")),
            }
        }
        Ok(convert_extended_json(doc).map_err(|m| self.err(&m))?)
    }

    fn array(&mut self) -> Result<Bson, ParseError> {
        self.expect('[')?;
        let mut items = Vec::new();
        loop {
            self.skip_ws()?;
            if self.peek() == Some(']') {
                self.pos += 1;
                break;
            }
            items.push(self.value()?);
            self.skip_ws()?;
            match self.peek() {
                Some(',') => self.pos += 1,
                Some(']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.err("Expected ',' or ']'")),
            }
        }
        Ok(Bson::Array(items))
    }

    fn string(&mut self) -> Result<String, ParseError> {
        let quote = self.peek().unwrap();
        self.pos += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err(self.err("Unterminated string")),
                Some(c) if c == quote => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some('\\') => {
                    self.pos += 1;
                    let esc = self.peek().ok_or_else(|| self.err("Unterminated string"))?;
                    self.pos += 1;
                    match esc {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        '0' => out.push('\0'),
                        'u' => {
                            let code = self.hex4()?;
                            if (0xD800..0xDC00).contains(&code)
                                && self.peek() == Some('\\')
                                && self.peek_at(1) == Some('u')
                            {
                                self.pos += 2;
                                let low = self.hex4()?;
                                let combined = 0x10000
                                    + ((code - 0xD800) << 10)
                                    + (low.wrapping_sub(0xDC00) & 0x3FF);
                                out.push(char::from_u32(combined).unwrap_or('\u{FFFD}'));
                            } else {
                                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            }
                        }
                        other => out.push(other),
                    }
                }
                Some(c) => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let mut code = 0u32;
        for _ in 0..4 {
            let c = self.peek().ok_or_else(|| self.err("Bad \\u escape"))?;
            let d = c.to_digit(16).ok_or_else(|| self.err("Bad \\u escape"))?;
            code = code * 16 + d;
            self.pos += 1;
        }
        Ok(code)
    }

    fn ident(&mut self) -> String {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if is_ident_char(c) {
                self.pos += 1;
            } else {
                break;
            }
        }
        self.chars[start..self.pos].iter().collect()
    }

    fn number(&mut self) -> Result<Bson, ParseError> {
        let start = self.pos;
        if matches!(self.peek(), Some('-') | Some('+')) {
            self.pos += 1;
        }
        // -Infinity / +Infinity
        if self.peek().map(is_ident_start).unwrap_or(false) {
            let word = self.ident();
            let neg = self.chars[start] == '-';
            return match word.as_str() {
                "Infinity" => Ok(Bson::Double(if neg {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                })),
                _ => Err(self.err(&format!("Unexpected '{word}' after sign"))),
            };
        }
        let mut is_float = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == '.' || c == 'e' || c == 'E' {
                is_float = true;
                self.pos += 1;
                if (c == 'e' || c == 'E') && matches!(self.peek(), Some('-') | Some('+')) {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        let text = text.trim_start_matches('+');
        if !is_float {
            if let Ok(v) = text.parse::<i32>() {
                return Ok(Bson::Int32(v));
            }
            if let Ok(v) = text.parse::<i64>() {
                return Ok(Bson::Int64(v));
            }
        }
        text.parse::<f64>()
            .map(Bson::Double)
            .map_err(|_| self.err(&format!("Invalid number '{text}'")))
    }

    fn regex_literal(&mut self) -> Result<Bson, ParseError> {
        self.pos += 1; // opening '/'
        let mut pattern = String::new();
        let mut in_class = false;
        loop {
            match self.peek() {
                None | Some('\n') => return Err(self.err("Unterminated regular expression")),
                Some('\\') => {
                    pattern.push('\\');
                    self.pos += 1;
                    if let Some(c) = self.peek() {
                        pattern.push(c);
                        self.pos += 1;
                    }
                }
                Some('[') => {
                    in_class = true;
                    pattern.push('[');
                    self.pos += 1;
                }
                Some(']') => {
                    in_class = false;
                    pattern.push(']');
                    self.pos += 1;
                }
                Some('/') if !in_class => {
                    self.pos += 1;
                    break;
                }
                Some(c) => {
                    pattern.push(c);
                    self.pos += 1;
                }
            }
        }
        let mut options = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_alphabetic() {
                options.push(c);
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(Bson::RegularExpression(make_regex(pattern, &options)))
    }

    /// Identifiers in value position: literals or constructor calls.
    fn word(&mut self) -> Result<Bson, ParseError> {
        let mut name = self.ident();
        if name == "new" {
            self.skip_ws()?;
            name = self.ident();
        }
        match name.as_str() {
            "true" => return Ok(Bson::Boolean(true)),
            "false" => return Ok(Bson::Boolean(false)),
            "null" => return Ok(Bson::Null),
            "undefined" => return Ok(Bson::Undefined),
            "NaN" => return Ok(Bson::Double(f64::NAN)),
            "Infinity" => return Ok(Bson::Double(f64::INFINITY)),
            "MinKey" | "MaxKey" => {
                self.skip_ws()?;
                if self.peek() == Some('(') {
                    self.expect('(')?;
                    self.expect(')')?;
                }
                return Ok(if name == "MinKey" {
                    Bson::MinKey
                } else {
                    Bson::MaxKey
                });
            }
            _ => {}
        }
        self.skip_ws()?;
        if self.peek() != Some('(') {
            return Err(self.err(&format!("Unknown value '{name}'")));
        }
        self.pos += 1;
        let mut args = Vec::new();
        loop {
            self.skip_ws()?;
            if self.peek() == Some(')') {
                self.pos += 1;
                break;
            }
            args.push(self.value()?);
            self.skip_ws()?;
            match self.peek() {
                Some(',') => self.pos += 1,
                Some(')') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.err("Expected ',' or ')'")),
            }
        }
        call(&name, args).map_err(|m| self.err(&m))
    }
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$' || c == '.'
}

fn make_regex(pattern: String, options: &str) -> Regex {
    let mut opts: Vec<char> = options.chars().filter(|c| "ilmsux".contains(*c)).collect();
    opts.sort_unstable();
    opts.dedup();
    Regex {
        pattern,
        options: opts.into_iter().collect(),
    }
}

fn arg_str(args: &[Bson], i: usize, func: &str) -> Result<String, String> {
    match args.get(i) {
        Some(Bson::String(s)) => Ok(s.clone()),
        _ => Err(format!("{func}() expects a string argument")),
    }
}

fn arg_i64(args: &[Bson], i: usize, func: &str) -> Result<i64, String> {
    match args.get(i) {
        Some(Bson::Int32(v)) => Ok(*v as i64),
        Some(Bson::Int64(v)) => Ok(*v),
        Some(Bson::Double(v)) if v.fract() == 0.0 => Ok(*v as i64),
        Some(Bson::String(s)) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("{func}() got an invalid number")),
        _ => Err(format!("{func}() expects a number")),
    }
}

pub fn parse_date(s: &str) -> Result<DateTime, String> {
    let s = s.trim();
    let candidate = if s.len() == 10 && s.as_bytes().get(4) == Some(&b'-') {
        format!("{s}T00:00:00Z")
    } else if !s.ends_with('Z')
        && !s.contains('+')
        && s.len() >= 19
        && s.rfind('-').map(|i| i < 10).unwrap_or(true)
    {
        format!("{s}Z")
    } else {
        s.to_string()
    };
    DateTime::parse_rfc3339_str(&candidate)
        .map_err(|_| format!("Invalid date \"{s}\" (use ISO 8601, e.g. 2026-11-19T14:30:00Z)"))
}

fn call(name: &str, args: Vec<Bson>) -> Result<Bson, String> {
    match name {
        "ObjectId" => {
            if args.is_empty() {
                return Ok(Bson::ObjectId(bson::oid::ObjectId::new()));
            }
            let hex = arg_str(&args, 0, name)?;
            bson::oid::ObjectId::parse_str(hex.trim())
                .map(Bson::ObjectId)
                .map_err(|_| format!("Invalid ObjectId \"{hex}\" (needs 24 hex characters)"))
        }
        "ISODate" | "Date" => {
            if args.is_empty() {
                return Ok(Bson::DateTime(DateTime::now()));
            }
            match &args[0] {
                Bson::String(s) => parse_date(s).map(Bson::DateTime),
                Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => Ok(Bson::DateTime(
                    DateTime::from_millis(arg_i64(&args, 0, name)?),
                )),
                _ => Err(format!("{name}() expects an ISO date string")),
            }
        }
        "NumberInt" | "Int32" => {
            let v = arg_i64(&args, 0, name)?;
            i32::try_from(v)
                .map(Bson::Int32)
                .map_err(|_| format!("{v} does not fit in a 32-bit integer"))
        }
        "NumberLong" | "Long" | "Int64" => Ok(Bson::Int64(arg_i64(&args, 0, name)?)),
        "Double" | "NumberDouble" => match args.first() {
            Some(Bson::Int32(v)) => Ok(Bson::Double(*v as f64)),
            Some(Bson::Int64(v)) => Ok(Bson::Double(*v as f64)),
            Some(Bson::Double(v)) => Ok(Bson::Double(*v)),
            Some(Bson::String(s)) => s
                .trim()
                .parse::<f64>()
                .map(Bson::Double)
                .map_err(|_| "Double() got an invalid number".to_string()),
            _ => Err("Double() expects a number".into()),
        },
        "NumberDecimal" | "Decimal128" => {
            let s = match args.first() {
                Some(Bson::String(s)) => s.clone(),
                Some(Bson::Int32(v)) => v.to_string(),
                Some(Bson::Int64(v)) => v.to_string(),
                Some(Bson::Double(v)) => v.to_string(),
                _ => return Err(format!("{name}() expects a string")),
            };
            Decimal128::from_str(s.trim())
                .map(Bson::Decimal128)
                .map_err(|_| format!("Invalid decimal \"{s}\""))
        }
        "Timestamp" => {
            let (t, i) = match args.first() {
                Some(Bson::Document(d)) => (
                    d.get("t")
                        .and_then(bson_as_i64)
                        .ok_or("Timestamp({t, i}) needs t")?,
                    d.get("i")
                        .and_then(bson_as_i64)
                        .ok_or("Timestamp({t, i}) needs i")?,
                ),
                _ => (arg_i64(&args, 0, name)?, arg_i64(&args, 1, name)?),
            };
            Ok(Bson::Timestamp(Timestamp {
                time: t as u32,
                increment: i as u32,
            }))
        }
        "BinData" => {
            let sub = arg_i64(&args, 0, name)? as u8;
            let b64 = arg_str(&args, 1, name)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|_| "BinData() got invalid base64".to_string())?;
            Ok(Bson::Binary(Binary {
                subtype: BinarySubtype::from(sub),
                bytes,
            }))
        }
        "UUID" => {
            let s = if args.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                arg_str(&args, 0, name)?
            };
            let u = uuid::Uuid::parse_str(s.trim()).map_err(|_| format!("Invalid UUID \"{s}\""))?;
            Ok(Bson::Binary(Binary {
                subtype: BinarySubtype::Uuid,
                bytes: u.as_bytes().to_vec(),
            }))
        }
        "RegExp" => {
            let pattern = arg_str(&args, 0, name)?;
            let flags = if args.len() > 1 {
                arg_str(&args, 1, name)?
            } else {
                String::new()
            };
            Ok(Bson::RegularExpression(make_regex(pattern, &flags)))
        }
        other => Err(format!("Unknown function {other}()")),
    }
}

fn bson_as_i64(b: &Bson) -> Option<i64> {
    match b {
        Bson::Int32(v) => Some(*v as i64),
        Bson::Int64(v) => Some(*v),
        Bson::Double(v) => Some(*v as i64),
        _ => None,
    }
}

/// Turn single-key Extended JSON wrapper documents into the BSON types they describe.
fn convert_extended_json(doc: Document) -> Result<Bson, String> {
    if doc.len() == 1 {
        let (key, value) = doc.iter().next().unwrap();
        let s = |v: &Bson| -> Option<String> {
            match v {
                Bson::String(s) => Some(s.clone()),
                _ => None,
            }
        };
        match key.as_str() {
            "$oid" => {
                if let Some(hex) = s(value) {
                    return call("ObjectId", vec![Bson::String(hex)]);
                }
            }
            "$numberLong" => {
                if let Some(v) = s(value) {
                    return call("NumberLong", vec![Bson::String(v)]);
                }
            }
            "$numberInt" => {
                if let Some(v) = s(value) {
                    return call("NumberInt", vec![Bson::String(v)]);
                }
            }
            "$numberDouble" => {
                if let Some(v) = s(value) {
                    return match v.as_str() {
                        "NaN" => Ok(Bson::Double(f64::NAN)),
                        "Infinity" => Ok(Bson::Double(f64::INFINITY)),
                        "-Infinity" => Ok(Bson::Double(f64::NEG_INFINITY)),
                        _ => call("Double", vec![Bson::String(v)]),
                    };
                }
            }
            "$numberDecimal" => {
                if let Some(v) = s(value) {
                    return call("NumberDecimal", vec![Bson::String(v)]);
                }
            }
            "$date" => match value {
                Bson::String(v) => return parse_date(v).map(Bson::DateTime),
                Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => {
                    return Ok(Bson::DateTime(DateTime::from_millis(
                        bson_as_i64(value).unwrap(),
                    )));
                }
                Bson::DateTime(_) => return Ok(value.clone()),
                _ => {}
            },
            "$minKey" => return Ok(Bson::MinKey),
            "$maxKey" => return Ok(Bson::MaxKey),
            _ => {}
        }
    }
    Ok(Bson::Document(doc))
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Pretty-print a document as shell JSON (2-space indent).
pub fn to_shell(doc: &Document) -> String {
    let mut out = String::new();
    write_value(&mut out, &Bson::Document(doc.clone()), 0);
    out
}

/// Compact single-line form of any value, e.g. for `_id` filters and tree cells.
pub fn to_shell_inline(value: &Bson) -> String {
    match value {
        Bson::Document(d) => {
            if d.is_empty() {
                return "{}".into();
            }
            let parts: Vec<String> = d
                .iter()
                .map(|(k, v)| format!("{}: {}", key_str(k), to_shell_inline(v)))
                .collect();
            format!("{{ {} }}", parts.join(", "))
        }
        Bson::Array(items) => {
            let parts: Vec<String> = items.iter().map(to_shell_inline).collect();
            format!("[{}]", parts.join(", "))
        }
        other => scalar(other),
    }
}

fn key_str(k: &str) -> String {
    let mut chars = k.chars();
    let simple = match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => k
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$'),
        _ => false,
    };
    if simple {
        k.to_string()
    } else {
        json_string(k)
    }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

pub fn format_double(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        // Debug keeps a decimal point for whole numbers (5.0) and uses the shortest round-trip form.
        format!("{v:?}")
    }
}

pub fn format_date(dt: &DateTime) -> String {
    dt.try_to_rfc3339_string()
        .unwrap_or_else(|_| dt.timestamp_millis().to_string())
}

fn scalar(value: &Bson) -> String {
    match value {
        Bson::Double(v) => format_double(*v),
        Bson::String(s) => json_string(s),
        Bson::Boolean(b) => b.to_string(),
        Bson::Null => "null".into(),
        Bson::Undefined => "undefined".into(),
        Bson::Int32(v) => v.to_string(),
        Bson::Int64(v) => format!("NumberLong({v})"),
        Bson::ObjectId(o) => format!("ObjectId(\"{}\")", o.to_hex()),
        Bson::DateTime(dt) => match dt.try_to_rfc3339_string() {
            Ok(s) => format!("ISODate(\"{s}\")"),
            Err(_) => format!("new Date({})", dt.timestamp_millis()),
        },
        Bson::Decimal128(d) => format!("NumberDecimal(\"{d}\")"),
        Bson::Timestamp(t) => format!("Timestamp({}, {})", t.time, t.increment),
        Bson::Binary(b) => {
            if b.subtype == BinarySubtype::Uuid && b.bytes.len() == 16 {
                let u = uuid::Uuid::from_slice(&b.bytes).unwrap_or_default();
                format!("UUID(\"{u}\")")
            } else {
                let sub: u8 = b.subtype.into();
                format!(
                    "BinData({}, \"{}\")",
                    sub,
                    base64::engine::general_purpose::STANDARD.encode(&b.bytes)
                )
            }
        }
        Bson::RegularExpression(r) => format!("/{}/{}", r.pattern.replace('/', "\\/"), r.options),
        Bson::JavaScriptCode(code) => format!("Code({})", json_string(code)),
        Bson::JavaScriptCodeWithScope(c) => format!("Code({})", json_string(&c.code)),
        Bson::Symbol(s) => format!("Symbol({})", json_string(s)),
        Bson::MinKey => "MinKey()".into(),
        Bson::MaxKey => "MaxKey()".into(),
        Bson::DbPointer(_) => "DBPointer(…)".into(),
        Bson::Document(_) | Bson::Array(_) => to_shell_inline(value),
    }
}

fn write_value(out: &mut String, value: &Bson, indent: usize) {
    let pad = "  ".repeat(indent + 1);
    let close_pad = "  ".repeat(indent);
    match value {
        Bson::Document(d) => {
            if d.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            let n = d.len();
            for (i, (k, v)) in d.iter().enumerate() {
                let _ = write!(out, "{pad}{}: ", key_str(k));
                write_value(out, v, indent + 1);
                if i + 1 < n {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&close_pad);
            out.push('}');
        }
        Bson::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            let all_scalar = items
                .iter()
                .all(|b| !matches!(b, Bson::Document(_) | Bson::Array(_)));
            if all_scalar {
                let inline = to_shell_inline(value);
                if inline.len() + indent * 2 <= 80 {
                    out.push_str(&inline);
                    return;
                }
            }
            out.push_str("[\n");
            let n = items.len();
            for (i, v) in items.iter().enumerate() {
                out.push_str(&pad);
                write_value(out, v, indent + 1);
                if i + 1 < n {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&close_pad);
            out.push(']');
        }
        other => out.push_str(&scalar(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn parses_relaxed_shell_syntax() {
        let d = parse_document(r#"{ status: 'out_for_delivery', "tenantId": "acme-ca", n: 5, big: 3000000000, f: 1.5, ok: true, x: null, }"#).unwrap();
        assert_eq!(d.get_str("status").unwrap(), "out_for_delivery");
        assert_eq!(d.get("n"), Some(&Bson::Int32(5)));
        assert_eq!(d.get("big"), Some(&Bson::Int64(3_000_000_000)));
        assert_eq!(d.get("f"), Some(&Bson::Double(1.5)));
        assert_eq!(d.get("ok"), Some(&Bson::Boolean(true)));
        assert_eq!(d.get("x"), Some(&Bson::Null));
    }

    #[test]
    fn parses_shell_constructors() {
        let d = parse_document(
            r#"{
              _id: ObjectId("6735a1f0c2e4b81a9d0f3e21"),
              eta: ISODate("2026-11-19T14:30:00Z"),
              d2: new Date("2026-11-19"),
              i: NumberInt("7"), l: NumberLong(9), dbl: Double(2),
              dec: NumberDecimal("1.10"),
              ts: Timestamp(1700000000, 3),
              u: UUID("0e9b6a2f-5d7c-4f4e-9b9a-2f7c5d1e6a3b"),
              b: BinData(0, "aGVsbG8="),
              r: /^acme/i, r2: RegExp("x", "m"),
              mn: MinKey(), mx: MaxKey
            }"#,
        )
        .unwrap();
        assert_eq!(
            d.get_object_id("_id").unwrap().to_hex(),
            "6735a1f0c2e4b81a9d0f3e21"
        );
        assert!(matches!(d.get("eta"), Some(Bson::DateTime(_))));
        assert_eq!(
            format_date(d.get_datetime("d2").unwrap()),
            "2026-11-19T00:00:00Z"
        );
        assert_eq!(d.get("i"), Some(&Bson::Int32(7)));
        assert_eq!(d.get("l"), Some(&Bson::Int64(9)));
        assert_eq!(d.get("dbl"), Some(&Bson::Double(2.0)));
        assert!(matches!(d.get("dec"), Some(Bson::Decimal128(_))));
        assert_eq!(
            d.get("ts"),
            Some(&Bson::Timestamp(Timestamp {
                time: 1_700_000_000,
                increment: 3
            }))
        );
        assert!(matches!(d.get("u"), Some(Bson::Binary(b)) if b.subtype == BinarySubtype::Uuid));
        assert!(matches!(d.get("b"), Some(Bson::Binary(b)) if b.bytes == b"hello"));
        assert!(
            matches!(d.get("r"), Some(Bson::RegularExpression(r)) if r.pattern == "^acme" && r.options == "i")
        );
        assert_eq!(d.get("mn"), Some(&Bson::MinKey));
        assert_eq!(d.get("mx"), Some(&Bson::MaxKey));
    }

    #[test]
    fn parses_canonical_extended_json() {
        let d = parse_document(r#"{"_id": {"$oid": "6735a1f0c2e4b81a9d0f3e21"}, "n": {"$numberLong": "12"}, "t": {"$date": "2026-01-02T03:04:05Z"}, "q": {"$gt": 5}}"#).unwrap();
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        assert_eq!(d.get("n"), Some(&Bson::Int64(12)));
        assert!(matches!(d.get("t"), Some(Bson::DateTime(_))));
        // Query operators stay documents.
        assert_eq!(d.get_document("q").unwrap(), &doc! {"$gt": 5});
    }

    #[test]
    fn comments_and_errors() {
        assert!(parse_document("// filter\n{ a: 1 /* note */ }").is_ok());
        let e = parse_document("{\n  a: ObjectId(\"nothex\")\n}").unwrap_err();
        assert_eq!(e.line, 2);
        assert!(e.message.contains("ObjectId"));
        assert!(parse_document("{ a: }").is_err());
        assert!(parse_document("{ a: 1 } trailing").is_err());
        assert_eq!(parse_document("   ").unwrap(), Document::new());
    }

    #[test]
    fn round_trips_types() {
        let original = doc! {
            "_id": bson::oid::ObjectId::parse_str("6735a1f0c2e4b81a9d0f3e21").unwrap(),
            "name": "Quote \" and \\ slash",
            "i32": 5i32,
            "i64": 5i64,
            "dbl": 5.0f64,
            "frac": 0.1f64,
            "when": DateTime::from_millis(1_763_562_600_123),
            "nested": { "deep": [1i32, "two", { "three": 3i64 }] },
            "empty": {},
            "list": [],
            "weird key": true,
            "dec": Decimal128::from_str("12.50").unwrap(),
        };
        let text = to_shell(&original);
        assert!(text.contains("i64: NumberLong(5)"));
        assert!(text.contains("dbl: 5.0"));
        assert!(text.contains("\"weird key\": true"));
        let back = parse_document(&text).unwrap();
        assert_eq!(back, original, "round trip changed the document:\n{text}");
    }

    #[test]
    fn pipeline_parsing() {
        let p = parse_pipeline("[ { $match: { a: 1 } }, { $limit: 5 } ]").unwrap();
        assert_eq!(p.len(), 2);
        assert!(parse_pipeline("[1]").is_err());
    }
}
