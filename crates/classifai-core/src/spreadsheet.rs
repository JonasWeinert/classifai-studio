//! Excel and OpenDocument workbooks (`.xlsx`, `.xlsm`, `.xls`, `.ods`): preview their sheets, then
//! read one sheet from a chosen header row, keeping chosen columns.

use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;

use crate::dataset::{ParsedDataset, Row, MAX_ROWS};
use crate::{Error, Result};

pub const EXTENSIONS: &[&str] = &["xlsx", "xlsm", "xlsb", "xls", "ods"];

/// Rows shown per sheet in the preview.
const PREVIEW_ROWS: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct SheetPreview {
    pub name: String,
    /// Row count of the used range.
    pub rows: usize,
    /// The first rows as text, padded to `width` cells.
    pub preview: Vec<Vec<String>>,
    pub width: usize,
    /// First non-empty row: the likely header.
    pub header_guess: usize,
}

pub fn is_workbook(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn cell(d: &Data) -> String {
    match d {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(t) if t.time() == chrono::NaiveTime::MIN => t.date().to_string(),
            Some(t) => t.format("%Y-%m-%d %H:%M:%S").to_string(),
            None => dt.as_f64().to_string(),
        },
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    }
}

fn open(path: &Path) -> Result<calamine::Sheets<std::io::BufReader<std::fs::File>>> {
    open_workbook_auto(path).map_err(|e| Error::invalid(format!("could not open the workbook: {e}")))
}

fn sheet_rows(path: &Path, sheet: &str) -> Result<Vec<Vec<String>>> {
    let mut wb = open(path)?;
    let range = wb.worksheet_range(sheet).map_err(|e| Error::invalid(format!("could not read sheet \"{sheet}\": {e}")))?;
    Ok(range.rows().map(|r| r.iter().map(cell).collect()).collect())
}

/// Every sheet with its first rows.
pub fn inspect(path: &Path) -> Result<Vec<SheetPreview>> {
    let mut wb = open(path)?;
    let names = wb.sheet_names().to_vec();
    if names.is_empty() {
        return Err(Error::invalid("the workbook has no sheets"));
    }
    names
        .into_iter()
        .map(|name| {
            let range = wb.worksheet_range(&name).map_err(|e| Error::invalid(format!("could not read sheet \"{name}\": {e}")))?;
            let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(cell).collect()).collect();
            let width = rows.iter().take(PREVIEW_ROWS).map(Vec::len).max().unwrap_or(0);
            let header_guess = rows.iter().position(|r| r.iter().filter(|c| !c.is_empty()).count() >= 1).unwrap_or(0);
            let preview = rows
                .iter()
                .take(PREVIEW_ROWS)
                .map(|r| {
                    let mut r = r.clone();
                    r.resize(width, String::new());
                    r
                })
                .collect();
            Ok(SheetPreview { name, rows: rows.len(), preview, width, header_guess })
        })
        .collect()
}

/// Read a sheet: row `header_row` (0-based) names the columns, the rows below are data. `columns`
/// are 0-based column positions to keep (all when empty). Empty rows are skipped; blank or
/// repeated header names become `column_N` / `name_2`.
pub fn read_sheet(path: &Path, sheet: &str, header_row: usize, columns: &[usize]) -> Result<ParsedDataset> {
    let rows = sheet_rows(path, sheet)?;
    let header = rows.get(header_row).ok_or_else(|| Error::invalid(format!("sheet \"{sheet}\" has no row {}", header_row + 1)))?;
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let keep: Vec<usize> = if columns.is_empty() { (0..width).collect() } else { columns.iter().copied().filter(|&c| c < width).collect() };
    if keep.is_empty() {
        return Err(Error::invalid("choose at least one column"));
    }
    let mut names: Vec<String> = Vec::new();
    for &c in &keep {
        let base = header.get(c).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("column_{}", c + 1));
        let mut name = base.clone();
        let mut n = 2;
        while names.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        names.push(name);
    }
    let data: Vec<Row> = rows
        .iter()
        .skip(header_row + 1)
        .filter(|r| keep.iter().any(|&c| r.get(c).is_some_and(|v| !v.is_empty())))
        .map(|r| names.iter().zip(&keep).map(|(n, &c)| (n.clone(), r.get(c).cloned().unwrap_or_default())).collect())
        .collect();
    if data.is_empty() {
        return Err(Error::invalid("no rows below the header row"));
    }
    if data.len() > MAX_ROWS {
        return Err(Error::invalid(format!("the sheet has more than {MAX_ROWS} rows")));
    }
    Ok(ParsedDataset { columns: names, rows: data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_read_as_text() {
        assert_eq!(cell(&Data::Float(3.0)), "3");
        assert_eq!(cell(&Data::Float(2.5)), "2.5");
        assert_eq!(cell(&Data::String("  hi ".into())), "hi");
        assert_eq!(cell(&Data::Empty), "");
        assert_eq!(cell(&Data::Bool(true)), "true");
    }
}
