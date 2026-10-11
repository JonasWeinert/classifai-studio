//! Real files through the importers: an .xlsx written with rust_xlsxwriter, a PDF written with
//! lopdf, and a .docx saved by macOS TextEdit (tests/fixtures/report.docx).

use std::path::{Path, PathBuf};

use classifai_core::{documents, spreadsheet};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("classifai-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

#[test]
fn xlsx_sheets_header_row_and_columns() {
    let path = tmp("tickets.xlsx");
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet().set_name("Notes").unwrap();
    ws.write(0, 0, "Exported from CRM").unwrap();
    for (c, h) in ["id", "message", "team", "amount", "message"].iter().enumerate() {
        ws.write(2, c as u16, *h).unwrap();
    }
    ws.write(3, 0, 1).unwrap();
    ws.write(3, 1, "Refund my double charge").unwrap();
    ws.write(3, 2, "billing").unwrap();
    ws.write(3, 3, 19.99).unwrap();
    ws.write(5, 0, 3).unwrap(); // row 4 is empty and skipped
    ws.write(5, 1, "Change my email").unwrap();
    ws.write(5, 2, "account").unwrap();
    wb.add_worksheet().set_name("Summary").unwrap().write(0, 0, "total").unwrap();
    wb.save(&path).unwrap();

    let sheets = spreadsheet::inspect(&path).unwrap();
    assert_eq!(sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Notes", "Summary"]);
    assert_eq!(sheets[0].preview[0][0], "Exported from CRM");
    assert_eq!(sheets[0].width, 5);

    let all = spreadsheet::read_sheet(&path, "Notes", 2, &[]).unwrap();
    assert_eq!(all.columns, ["id", "message", "team", "amount", "message_2"]);
    assert_eq!(all.rows.len(), 2);
    assert_eq!(all.rows[0]["amount"], "19.99");
    assert_eq!(all.rows[1]["id"], "3");

    let some = spreadsheet::read_sheet(&path, "Notes", 2, &[1, 2]).unwrap();
    assert_eq!(some.columns, ["message", "team"]);
    assert_eq!(some.rows[1]["team"], "account");
}

#[test]
fn pdf_text_becomes_markdown() {
    let path = tmp("paper.pdf");
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
    let mut ops = vec![Operation::new("BT", vec![]), Operation::new("Tf", vec!["F1".into(), 12.into()]), Operation::new("TL", vec![14.into()]), Operation::new("Td", vec![72.into(), 760.into()])];
    for line in ["Abstract", "We study hyphen-", "ated words across lines."] {
        ops.push(Operation::new("Tj", vec![Object::string_literal(line)]));
        ops.push(Operation::new("T*", vec![]));
    }
    ops.push(Operation::new("ET", vec![]));
    let content_id = doc.add_object(Stream::new(dictionary! {}, Content { operations: ops }.encode().unwrap()));
    let page_id = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => content_id });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1, "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()] }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.save(&path).unwrap();

    let md = documents::pdf_to_markdown(&path).unwrap();
    assert!(md.contains("Abstract"), "{md}");
    assert!(md.contains("hyphenated words across lines."), "{md}");
}

#[test]
fn docx_from_textedit_becomes_markdown() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/report.docx");
    let md = documents::docx_to_markdown(&path).unwrap();
    // TextEdit marks the title only by font size, types bullets as text and flattens tables.
    assert!(md.starts_with("# Quarterly report\n\n"), "{md}");
    assert!(md.contains("Revenue grew **12%** and costs were *flat*."), "{md}");
    assert!(md.contains("- North\n- South"), "{md}");
}
