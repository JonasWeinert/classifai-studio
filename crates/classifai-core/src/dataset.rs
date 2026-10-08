//! Parse tabular files into string rows. Supported: `.csv`, `.tsv`, `.json` (array of objects),
//! `.jsonl` / `.ndjson` (one object per line). Nested JSON values are kept as compact JSON text.

use std::path::Path;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::{Error, Result};

pub type Row = IndexMap<String, String>;

#[derive(Debug, Clone, Serialize)]
pub struct ParsedDataset {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
}

pub const MAX_ROWS: usize = 200_000;

pub fn parse_file(path: &Path) -> Result<ParsedDataset> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let text = std::fs::read_to_string(path)?;
    match ext.as_str() {
        "json" => parse_json(&text),
        "jsonl" | "ndjson" => parse_jsonl(&text),
        "tsv" | "tab" => parse_delimited(&text, b'\t'),
        _ => parse_delimited(&text, sniff_delimiter(&text)),
    }
}

/// Parse pasted text: JSON (array or object) or JSON Lines when it starts with `[` or `{`,
/// otherwise CSV/TSV with the delimiter sniffed from the header line.
pub fn parse_text(text: &str) -> Result<ParsedDataset> {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let trimmed = body.trim_start();
    if trimmed.starts_with('[') {
        return parse_json(trimmed);
    }
    if trimmed.starts_with('{') {
        // One object per line is JSON Lines; a single (possibly multi-line) object is JSON.
        return parse_jsonl(trimmed).or_else(|jsonl_err| parse_json(trimmed).map_err(|_| jsonl_err));
    }
    parse_delimited(body, sniff_delimiter(body))
}

fn sniff_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    [b',', b';', b'\t', b'|']
        .into_iter()
        .max_by_key(|d| first.bytes().filter(|b| b == d).count())
        .unwrap_or(b',')
}

pub fn parse_delimited(text: &str, delimiter: u8) -> Result<ParsedDataset> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(text.as_bytes());
    let columns = dedupe_columns(rdr.headers()?.iter().map(|h| h.trim().to_string()).collect());
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let rec = rec?;
        if rec.iter().all(|f| f.trim().is_empty()) {
            continue;
        }
        let row: Row = columns
            .iter()
            .enumerate()
            .map(|(i, c)| (c.clone(), rec.get(i).unwrap_or("").to_string()))
            .collect();
        rows.push(row);
        if rows.len() > MAX_ROWS {
            return Err(Error::invalid(format!("dataset has more than {MAX_ROWS} rows")));
        }
    }
    finish(columns, rows)
}

pub fn parse_json(text: &str) -> Result<ParsedDataset> {
    let v: Value = serde_json::from_str(text)?;
    let items = match v {
        Value::Array(a) => a,
        // { "data": [...] } or { "rows": [...] }: take the first array value
        Value::Object(o) => o
            .into_iter()
            .find_map(|(_, v)| if let Value::Array(a) = v { Some(a) } else { None })
            .ok_or_else(|| Error::invalid("JSON file must be an array of objects"))?,
        _ => return Err(Error::invalid("JSON file must be an array of objects")),
    };
    from_objects(items)
}

pub fn parse_jsonl(text: &str) -> Result<ParsedDataset> {
    let mut items = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        items.push(
            serde_json::from_str(line)
                .map_err(|e| Error::invalid(format!("line {}: {e}", i + 1)))?,
        );
    }
    from_objects(items)
}

fn from_objects(items: Vec<Value>) -> Result<ParsedDataset> {
    let mut columns: IndexMap<String, ()> = IndexMap::new();
    let mut objs = Vec::with_capacity(items.len());
    for item in items {
        let obj = match item {
            Value::Object(o) => o,
            other => {
                let mut m = serde_json::Map::new();
                m.insert("text".into(), other);
                m
            }
        };
        for k in obj.keys() {
            columns.entry(k.clone()).or_insert(());
        }
        objs.push(obj);
    }
    let columns: Vec<String> = columns.into_keys().collect();
    let rows = objs
        .into_iter()
        .map(|o| {
            columns
                .iter()
                .map(|c| (c.clone(), o.get(c).map(value_to_cell).unwrap_or_default()))
                .collect()
        })
        .collect();
    finish(columns, rows)
}

fn value_to_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn dedupe_columns(cols: Vec<String>) -> Vec<String> {
    let mut seen: IndexMap<String, usize> = IndexMap::new();
    cols.into_iter()
        .enumerate()
        .map(|(i, c)| {
            let base = if c.is_empty() { format!("column_{}", i + 1) } else { c };
            let n = seen.entry(base.clone()).or_insert(0);
            *n += 1;
            if *n == 1 { base } else { format!("{base}_{n}") }
        })
        .collect()
}

fn finish(columns: Vec<String>, rows: Vec<Row>) -> Result<ParsedDataset> {
    if columns.is_empty() {
        return Err(Error::invalid("no columns found"));
    }
    if rows.is_empty() {
        return Err(Error::invalid("no rows found"));
    }
    Ok(ParsedDataset { columns, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_with_semicolons_and_bom() {
        let d = parse_delimited("\u{feff}text;label\nhello;a\n\"x;y\";b\n", sniff_delimiter("text;label")).unwrap();
        assert_eq!(d.columns, vec!["text", "label"]);
        assert_eq!(d.rows.len(), 2);
        assert_eq!(d.rows[1]["text"], "x;y");
    }

    #[test]
    fn jsonl_mixed_keys() {
        let d = parse_jsonl("{\"text\":\"a\",\"label\":1}\n\n{\"text\":\"b\",\"meta\":{\"k\":true}}\n").unwrap();
        assert_eq!(d.columns, vec!["text", "label", "meta"]);
        assert_eq!(d.rows[0]["label"], "1");
        assert_eq!(d.rows[1]["label"], "");
        assert_eq!(d.rows[1]["meta"], "{\"k\":true}");
    }

    #[test]
    fn pasted_text_formats() {
        let tsv = parse_text("text\tlabel\nhello, world\ta\n").unwrap();
        assert_eq!(tsv.columns, vec!["text", "label"]);
        assert_eq!(tsv.rows[0]["text"], "hello, world");
        let csv = parse_text("\u{feff}a,b\n1,2\n3,4\n").unwrap();
        assert_eq!(csv.rows.len(), 2);
        let json = parse_text("  [{\"text\": \"x\", \"n\": 2}]").unwrap();
        assert_eq!(json.rows[0]["n"], "2");
        let jsonl = parse_text("{\"t\":\"a\"}\n{\"t\":\"b\"}\n").unwrap();
        assert_eq!(jsonl.rows.len(), 2);
        let wrapped = parse_text("{\n  \"rows\": [{\"t\": \"a\"}]\n}").unwrap();
        assert_eq!(wrapped.rows[0]["t"], "a");
        assert!(parse_text("{not json").is_err());
        assert!(parse_text("").is_err());
    }

    #[test]
    fn duplicate_headers() {
        let d = parse_delimited("a,a,\n1,2,3\n", b',').unwrap();
        assert_eq!(d.columns, vec!["a", "a_2", "column_3"]);
    }
}
