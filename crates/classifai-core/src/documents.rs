//! Files as dataset rows: text and Markdown as they are, Word documents and PDFs converted to
//! Markdown, images copied into the app's media folder under a new name. Every row records the
//! original path.

use std::io::Read;
use std::path::{Path, PathBuf};

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

use crate::dataset::{ParsedDataset, Row};
use crate::{Error, Result};

pub const TEXT_EXTENSIONS: &[&str] = &["txt", "md", "markdown"];
pub const DOC_EXTENSIONS: &[&str] = &["docx", "pdf"];
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"];

/// Columns of a files dataset.
pub const COLUMNS: [&str; 5] = ["name", "kind", "content", "file", "source_path"];

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug)]
pub struct FilesImport {
    pub data: ParsedDataset,
    pub skipped: Vec<Skipped>,
}

fn ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// A safe, readable file name: `Quarterly Report (final).PNG` -> `quarterly-report-final`.
fn slug(stem: &str) -> String {
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(60).collect::<String>();
    if out.is_empty() { "file".into() } else { out }
}

/// Import files as rows. Images are copied to `media_dir` as `0001-name.ext`; the row links the copy
/// (`file`) and the original (`source_path`). Unreadable files are skipped with a reason.
pub fn import_files(paths: &[PathBuf], media_dir: &Path) -> Result<FilesImport> {
    let mut rows = Vec::new();
    let mut skipped = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let e = ext(path);
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let source = path.display().to_string();
        let result: Result<(String, String, String)> = if TEXT_EXTENSIONS.contains(&e.as_str()) {
            std::fs::read_to_string(path).map(|t| ("text".into(), t, String::new())).map_err(Into::into)
        } else if e == "docx" {
            docx_to_markdown(path).map(|t| ("docx".into(), t, String::new()))
        } else if e == "pdf" {
            pdf_to_markdown(path).map(|t| ("pdf".into(), t, String::new()))
        } else if IMAGE_EXTENSIONS.contains(&e.as_str()) {
            (|| {
                std::fs::create_dir_all(media_dir)?;
                let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let dest = media_dir.join(format!("{:04}-{}.{e}", i + 1, slug(&stem)));
                std::fs::copy(path, &dest)?;
                Ok(("image".to_string(), String::new(), dest.display().to_string()))
            })()
        } else {
            Err(Error::invalid(format!("unsupported file type .{e}")))
        };
        match result {
            Ok((kind, content, file)) => {
                let row: Row = [
                    ("name", name),
                    ("kind", kind),
                    ("content", content.trim().to_string()),
                    ("file", file),
                    ("source_path", source),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
                rows.push(row);
            }
            Err(err) => skipped.push(Skipped { path: source, reason: err.to_string() }),
        }
    }
    if rows.is_empty() {
        let why = skipped.first().map(|s| format!(": {}", s.reason)).unwrap_or_default();
        return Err(Error::invalid(format!("no file could be imported{why}")));
    }
    Ok(FilesImport { data: ParsedDataset { columns: COLUMNS.iter().map(|c| c.to_string()).collect(), rows }, skipped })
}

// ---- PDF --------------------------------------------------------------------------------------

/// The text of a PDF as Markdown paragraphs (no layout or images). Scanned PDFs have no text.
pub fn pdf_to_markdown(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    // pdf-extract panics on some malformed files; treat that as an unreadable PDF.
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
        .map_err(|_| Error::invalid("this PDF could not be read"))?
        .map_err(|e| Error::invalid(format!("this PDF could not be read: {e}")))?;
    let md = tidy_pdf_text(&text);
    if md.is_empty() {
        return Err(Error::invalid("this PDF has no text (is it a scan?)"));
    }
    Ok(md)
}

/// Join lines broken mid-paragraph, undo end-of-line hyphenation, keep blank-line paragraph breaks.
fn tidy_pdf_text(text: &str) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !cur.is_empty() {
                paragraphs.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if cur.ends_with('-') && line.chars().next().is_some_and(char::is_lowercase) {
            cur.pop();
            cur.push_str(line);
        } else {
            if !cur.is_empty() {
                cur.push(' ');
            }
            cur.push_str(line);
        }
    }
    if !cur.is_empty() {
        paragraphs.push(cur);
    }
    paragraphs.join("\n\n")
}

// ---- DOCX -------------------------------------------------------------------------------------

/// A Word document as Markdown: headings, lists, bold/italic, line breaks and tables.
pub fn docx_to_markdown(path: &Path) -> Result<String> {
    let file = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| Error::invalid(format!("not a Word document: {e}")))?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| Error::invalid("not a Word document (no word/document.xml)"))?
        .read_to_string(&mut xml)?;
    Ok(document_xml_to_markdown(&xml))
}

#[derive(Default)]
struct Para {
    text: String,
    heading: Option<usize>,
    list: Option<usize>,
    /// Smallest font size (half-points) of the runs with text; None when a run had no size.
    min_size: Option<u32>,
    has_unsized_run: bool,
}

/// Bullet characters typed as text (documents without list styles, e.g. from TextEdit).
const BULLETS: &[char] = &['•', '◦', '▪', '‣', '●', '○', '■', '–'];

fn document_xml_to_markdown(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    let mut out: Vec<String> = Vec::new();
    let mut para: Option<Para> = None;
    let (mut bold, mut italic) = (false, false);
    let mut size: Option<u32> = None;
    let mut in_text = false;
    let mut run = String::new();
    // Tables: rows of cells; a cell collects its paragraphs.
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell: Option<String> = None;
    let mut depth_tbl = 0usize;

    let flush_run = |para: &mut Option<Para>, run: &mut String, bold: bool, italic: bool, size: Option<u32>| {
        if run.is_empty() {
            return;
        }
        if let Some(p) = para.as_mut() {
            if !run.trim().is_empty() {
                match size {
                    Some(sz) => p.min_size = Some(p.min_size.map_or(sz, |m| m.min(sz))),
                    None => p.has_unsized_run = true,
                }
            }
            let t = std::mem::take(run);
            let (lead, core, trail) = split_ws(&t);
            let wrapped = match (bold, italic, core.is_empty()) {
                (_, _, true) => core.to_string(),
                (true, true, _) => format!("***{core}***"),
                (true, false, _) => format!("**{core}**"),
                (false, true, _) => format!("*{core}*"),
                _ => core.to_string(),
            };
            p.text.push_str(lead);
            p.text.push_str(&wrapped);
            p.text.push_str(trail);
        }
        run.clear();
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"p" => para = Some(Para::default()),
                    b"r" => {
                        bold = false;
                        italic = false;
                        size = None;
                    }
                    b"sz" => size = attr(&e, b"val").and_then(|v| v.parse().ok()),
                    b"b" if !is_off(&e) => bold = true,
                    b"i" if !is_off(&e) => italic = true,
                    b"t" => in_text = true,
                    b"tab" => run.push('\t'),
                    b"br" | b"cr" => run.push_str("  \n"),
                    b"pStyle" => {
                        let style = attr(&e, b"val").unwrap_or_default().to_ascii_lowercase();
                        if let Some(p) = para.as_mut() {
                            if style == "title" {
                                p.heading = Some(1);
                            } else if let Some(n) = style.strip_prefix("heading").and_then(|n| n.parse::<usize>().ok()) {
                                p.heading = Some(n.clamp(1, 6));
                            } else if style.contains("list") && p.list.is_none() {
                                p.list = Some(0);
                            }
                        }
                    }
                    b"ilvl" => {
                        if let Some(p) = para.as_mut() {
                            p.list = Some(attr(&e, b"val").and_then(|v| v.parse().ok()).unwrap_or(0));
                        }
                    }
                    b"numPr" => {
                        if let Some(p) = para.as_mut() {
                            p.list.get_or_insert(0);
                        }
                    }
                    b"tbl" => {
                        depth_tbl += 1;
                        if depth_tbl == 1 {
                            table = Some(Vec::new());
                        }
                    }
                    b"tr" if depth_tbl == 1 => {
                        if let Some(t) = table.as_mut() {
                            t.push(Vec::new());
                        }
                    }
                    b"tc" if depth_tbl == 1 => cell = Some(String::new()),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => run.push_str(&t.unescape().unwrap_or_default()),
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"r" => flush_run(&mut para, &mut run, bold, italic, size),
                b"p" => {
                    flush_run(&mut para, &mut run, bold, italic, size);
                    if let Some(p) = para.take() {
                        let text = p.text.trim_end().to_string();
                        if let Some(c) = cell.as_mut() {
                            if !text.is_empty() {
                                if !c.is_empty() {
                                    c.push_str("<br>");
                                }
                                c.push_str(&text.replace('|', "\\|").replace("  \n", "<br>"));
                            }
                        } else if !text.trim().is_empty() {
                            let trimmed = text.trim_start();
                            let bullet = trimmed.starts_with(BULLETS).then(|| trimmed.trim_start_matches(BULLETS).trim().to_string());
                            // Large text that fills a short paragraph reads as a heading (≥ 16 pt).
                            let by_size = match p.min_size {
                                Some(sz) if !p.has_unsized_run && sz >= 32 && text.chars().count() <= 150 => Some(if sz >= 44 { 1 } else if sz >= 36 { 2 } else { 3 }),
                                _ => None,
                            };
                            let heading = p.heading.or(by_size);
                            let list = p.list.or(bullet_level(trimmed));
                            let text = match (heading, bullet) {
                                (Some(_), _) => text.trim().trim_start_matches("**").trim_end_matches("**").to_string(),
                                (None, Some(b)) => b,
                                _ => text,
                            };

                            out.push(match (heading, list) {
                                (Some(h), _) => format!("{} {}", "#".repeat(h), text.trim()),
                                (None, Some(l)) => format!("{}- {}", "  ".repeat(l), text.trim()),
                                _ => text,
                            });
                        }
                    }
                }
                b"tc" if depth_tbl == 1 => {
                    if let (Some(t), Some(c)) = (table.as_mut(), cell.take()) {
                        if let Some(r) = t.last_mut() {
                            r.push(c);
                        }
                    }
                }
                b"tbl" => {
                    depth_tbl = depth_tbl.saturating_sub(1);
                    if depth_tbl == 0 {
                        if let Some(t) = table.take() {
                            out.push(markdown_table(&t));
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    // Consecutive list items stay together; everything else is separated by a blank line.
    let mut md = String::new();
    for (i, block) in out.iter().enumerate() {
        if i > 0 {
            let both_list = |b: &str| b.trim_start().starts_with("- ");
            md.push_str(if both_list(block) && both_list(&out[i - 1]) { "\n" } else { "\n\n" });
        }
        md.push_str(block);
    }
    md
}

/// A typed bullet starts a top-level list item.
fn bullet_level(text: &str) -> Option<usize> {
    text.starts_with(BULLETS).then_some(0)
}

fn markdown_table(rows: &[Vec<String>]) -> String {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let line = |r: &Vec<String>| {
        let cells: Vec<String> = (0..width).map(|i| r.get(i).cloned().unwrap_or_default()).collect();
        format!("| {} |", cells.join(" | "))
    };
    let mut out = vec![line(&rows[0]), format!("|{}|", vec![" --- "; width].join("|"))];
    out.extend(rows.iter().skip(1).map(line));
    out.join("\n")
}

fn split_ws(s: &str) -> (&str, &str, &str) {
    let start = s.len() - s.trim_start().len();
    let end = s.trim_end().len();
    if start >= end {
        return (s, "", "");
    }
    (&s[..start], &s[start..end], &s[end..])
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == key)
        .map(|a| String::from_utf8_lossy(&a.value).to_string())
}

/// `<w:b w:val="0"/>` turns bold off.
fn is_off(e: &quick_xml::events::BytesStart) -> bool {
    matches!(attr(e, b"val").as_deref(), Some("0" | "false" | "none"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"<w:document xmlns:w="w"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Results</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Plain and </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
             <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2|3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>End</w:t></w:r><w:r><w:br/><w:t>line two</w:t></w:r></w:p>
    </w:body></w:document>"#;

    #[test]
    fn docx_xml_becomes_markdown() {
        let md = document_xml_to_markdown(DOC);
        assert_eq!(
            md,
            "# Results\n\nPlain and **bold** and *italic*.\n\n- one\n  - two\n\n| a | b |\n| --- | --- |\n| 1 | 2\\|3 |\n\nEnd  \nline two"
        );
    }

    #[test]
    fn pdf_text_is_tidied() {
        assert_eq!(tidy_pdf_text("A para-\ngraph that\nwraps.\n\n\nNext one."), "A paragraph that wraps.\n\nNext one.");
    }

    #[test]
    fn files_become_rows_and_images_are_copied() {
        let dir = std::env::temp_dir().join(format!("classifai-docs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("Note One.md");
        std::fs::write(&txt, "# hi\nthere").unwrap();
        let img = dir.join("My Photo (1).PNG");
        std::fs::write(&img, b"\x89PNG fake").unwrap();
        let bad = dir.join("x.xyz");
        std::fs::write(&bad, "?").unwrap();
        let media = dir.join("media");
        let r = import_files(&[txt.clone(), img.clone(), bad], &media).unwrap();
        assert_eq!(r.data.columns, COLUMNS);
        assert_eq!(r.data.rows.len(), 2);
        assert_eq!(r.data.rows[0]["kind"], "text");
        assert_eq!(r.data.rows[0]["content"], "# hi\nthere");
        assert_eq!(r.data.rows[1]["kind"], "image");
        assert!(r.data.rows[1]["file"].ends_with("0002-my-photo-1.png"), "{}", r.data.rows[1]["file"]);
        assert!(Path::new(&r.data.rows[1]["file"]).exists());
        assert_eq!(r.data.rows[1]["source_path"], img.display().to_string());
        assert_eq!(r.skipped.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
