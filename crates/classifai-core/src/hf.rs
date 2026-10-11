//! Import datasets from the Hugging Face Hub through the dataset viewer API
//! (<https://datasets-server.huggingface.co>): configs, splits and features, then rows of each
//! chosen split, either all of them or a subset (first rows, a seeded random sample, a row range,
//! an SQL filter or a full-text search).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::stream::{self, StreamExt, TryStreamExt};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dataset::{value_to_cell, ParsedDataset, Row, MAX_ROWS};
use crate::{Error, Result};

const API: &str = "https://datasets-server.huggingface.co";
/// The viewer API returns at most this many rows per request.
const PAGE: usize = 100;
const PARALLEL: usize = 6;

#[derive(Debug, Clone, Serialize)]
pub struct HfInfo {
    /// `owner/name`
    pub dataset: String,
    pub configs: Vec<HfConfig>,
    /// The viewer can filter (SQL WHERE) and search this dataset.
    pub can_filter: bool,
    pub can_search: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfConfig {
    pub config: String,
    pub features: Vec<HfFeature>,
    pub splits: Vec<HfSplit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfFeature {
    pub name: String,
    /// `string`, `int64`, `ClassLabel`, `Image`, `Sequence`…
    pub kind: String,
    /// Label names of a ClassLabel feature.
    pub labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfSplit {
    pub split: String,
    pub num_rows: Option<usize>,
}

/// Which rows of a split to import.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HfSelection {
    Full,
    First { n: usize },
    /// `n` rows drawn uniformly without replacement; the same seed gives the same rows.
    Random { n: usize, seed: u64 },
    Range { offset: usize, n: usize },
    /// An SQL WHERE clause over the columns, e.g. `"label" = 1`; the first `n` matches.
    Filter {
        #[serde(rename = "where")]
        clause: String,
        n: usize,
    },
    /// Full-text search over the text columns; the first `n` matches.
    Search { query: String, n: usize },
}

#[derive(Debug, Clone, Deserialize)]
pub struct HfPart {
    pub config: String,
    pub split: String,
    pub selection: HfSelection,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HfImportSpec {
    pub dataset: String,
    pub parts: Vec<HfPart>,
    /// One dataset with a `split` column (true) or one dataset per part.
    #[serde(default)]
    pub combine: bool,
    /// Name of the combined dataset (or prefix of per-part names).
    #[serde(default)]
    pub name: Option<String>,
    /// Columns to keep (all when empty).
    #[serde(default)]
    pub columns: Vec<String>,
}

/// One imported table, ready for [`crate::store::Store::insert_dataset`].
#[derive(Debug)]
pub struct HfTable {
    pub name: String,
    pub source: String,
    pub data: ParsedDataset,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfProgress {
    pub part: usize,
    pub parts: usize,
    pub label: String,
    pub done: usize,
    pub total: usize,
}

/// `owner/name` from a name, `hf://datasets/…` or a huggingface.co URL.
pub fn parse_dataset_ref(input: &str) -> Result<String> {
    let s = input.trim().trim_end_matches('/');
    let s = s
        .strip_prefix("hf://datasets/")
        .or_else(|| s.split_once("huggingface.co/datasets/").map(|(_, rest)| rest))
        .unwrap_or(s);
    let parts: Vec<&str> = s.split(['/', '?', '#']).filter(|p| !p.is_empty()).collect();
    let id = match parts.as_slice() {
        [owner, name, ..] if !s.contains("huggingface.co") && !matches!(*name, "viewer" | "tree" | "blob") => format!("{owner}/{name}"),
        [owner, name, ..] => format!("{owner}/{name}"),
        [name] => name.to_string(),
        _ => return Err(Error::invalid("enter a dataset name like stanfordnlp/imdb, or its Hugging Face URL")),
    };
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c)) {
        return Err(Error::invalid(format!("\"{id}\" is not a Hugging Face dataset name")));
    }
    Ok(id)
}

pub struct HfClient {
    http: reqwest::Client,
    token: Option<String>,
}

impl HfClient {
    pub fn new(token: Option<String>) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().unwrap_or_default();
        Self { http, token: token.filter(|t| !t.trim().is_empty()) }
    }

    /// GET an endpoint, retrying rate limits and server hiccups with backoff.
    async fn get(&self, endpoint: &str, query: &[(&str, String)]) -> Result<Value> {
        let mut wait = Duration::from_millis(700);
        for attempt in 0..6 {
            let mut req = self.http.get(format!("{API}/{endpoint}")).query(query);
            if let Some(t) = &self.token {
                req = req.bearer_auth(t);
            }
            let resp = req.send().await.map_err(|e| Error::invalid(format!("could not reach Hugging Face: {e}")))?;
            let status = resp.status();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let message = body.get("error").and_then(Value::as_str).unwrap_or("").to_string();
            let retry = status.as_u16() == 429 || status.is_server_error() || message.contains("index is loading");
            if status.is_success() && message.is_empty() {
                return Ok(body);
            }
            if retry && attempt < 5 {
                tokio::time::sleep(wait).await;
                wait *= 2;
                continue;
            }
            return Err(match status.as_u16() {
                401 | 403 | 404 => Error::invalid(if self.token.is_some() {
                    "Hugging Face did not find this dataset, or your token has no access to it".to_string()
                } else {
                    "Hugging Face did not find this dataset. If it is private or gated, add your Hugging Face token".to_string()
                }),
                _ if message.contains("index is loading") => {
                    Error::invalid("Hugging Face is still indexing this dataset for filtering and search; try again in a minute or pick another subset")
                }
                _ if !message.is_empty() => Error::invalid(format!("Hugging Face: {message}")),
                code => Error::invalid(format!("Hugging Face answered {code}")),
            });
        }
        unreachable!()
    }

    pub async fn info(&self, input: &str) -> Result<HfInfo> {
        let dataset = parse_dataset_ref(input)?;
        let q = |extra: Option<(&'static str, String)>| {
            let mut v = vec![("dataset", dataset.clone())];
            v.extend(extra);
            v
        };
        let splits = self.get("splits", &q(None)).await?;
        let mut order: IndexMap<String, Vec<String>> = IndexMap::new();
        for s in splits["splits"].as_array().into_iter().flatten() {
            let (Some(c), Some(sp)) = (s["config"].as_str(), s["split"].as_str()) else { continue };
            order.entry(c.to_string()).or_default().push(sp.to_string());
        }
        if order.is_empty() {
            return Err(Error::invalid("this dataset has no splits the Hugging Face viewer can read"));
        }
        let valid = self.get("is-valid", &q(None)).await.unwrap_or(Value::Null);
        let infos = stream::iter(order.keys().cloned())
            .map(|config| {
                let dataset = dataset.clone();
                async move {
                    let info = self.get("info", &[("dataset", dataset), ("config", config.clone())]).await;
                    (config, info)
                }
            })
            .buffered(PARALLEL)
            .collect::<Vec<_>>()
            .await;
        let configs = infos
            .into_iter()
            .map(|(config, info)| {
                let info = info.unwrap_or(Value::Null);
                let di = &info["dataset_info"];
                let features = di["features"]
                    .as_object()
                    .map(|f| f.iter().map(|(name, t)| feature(name, t)).collect())
                    .unwrap_or_default();
                let splits = order[&config]
                    .iter()
                    .map(|s| HfSplit {
                        split: s.clone(),
                        num_rows: di["splits"][s]["num_examples"].as_u64().map(|n| n as usize),
                    })
                    .collect();
                HfConfig { config, features, splits }
            })
            .collect();
        Ok(HfInfo {
            dataset,
            configs,
            can_filter: valid["filter"].as_bool().unwrap_or(false),
            can_search: valid["search"].as_bool().unwrap_or(false),
        })
    }

    /// Rows `[offset, offset + n)` of a split, fetched in parallel pages.
    async fn range(&self, dataset: &str, config: &str, split: &str, offset: usize, n: usize, on_rows: &(dyn Fn(usize) + Sync)) -> Result<Vec<Value>> {
        let pages: Vec<(usize, usize)> = (0..n).step_by(PAGE).map(|i| (offset + i, PAGE.min(n - i))).collect();
        let mut out: Vec<(usize, Vec<Value>)> = stream::iter(pages)
            .map(|(off, len)| async move {
                let v = self.page("rows", dataset, config, split, off, len, &[]).await?;
                on_rows(v.0.len());
                Ok::<_, Error>((off, v.0))
            })
            .buffer_unordered(PARALLEL)
            .try_collect()
            .await?;
        out.sort_by_key(|(o, _)| *o);
        Ok(out.into_iter().flat_map(|(_, r)| r).collect())
    }

    /// One page of an endpoint; returns its rows and `num_rows_total` when given.
    #[allow(clippy::too_many_arguments)]
    async fn page(&self, endpoint: &str, dataset: &str, config: &str, split: &str, offset: usize, length: usize, extra: &[(&str, String)]) -> Result<(Vec<Value>, Option<usize>)> {
        let mut q = vec![
            ("dataset", dataset.to_string()),
            ("config", config.to_string()),
            ("split", split.to_string()),
            ("offset", offset.to_string()),
            ("length", length.to_string()),
        ];
        q.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        let body = self.get(endpoint, &q).await?;
        let rows = body["rows"].as_array().cloned().unwrap_or_default().into_iter().map(|r| r["row"].clone()).collect();
        Ok((rows, body["num_rows_total"].as_u64().map(|n| n as usize)))
    }

    /// Up to `n` matches of a filter or search, page by page.
    async fn matches(&self, endpoint: &str, dataset: &str, config: &str, split: &str, extra: &[(&str, String)], n: usize, on_rows: &(dyn Fn(usize) + Sync)) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        while out.len() < n {
            let (rows, total) = self.page(endpoint, dataset, config, split, out.len(), PAGE.min(n - out.len()), extra).await?;
            let got = rows.len();
            on_rows(got);
            out.extend(rows);
            if got == 0 || total.is_some_and(|t| out.len() >= t) {
                break;
            }
        }
        Ok(out)
    }

    /// Rows of one part, in order (random samples in row order).
    async fn part_rows(&self, dataset: &str, part: &HfPart, num_rows: Option<usize>, on_rows: &(dyn Fn(usize) + Sync)) -> Result<Vec<Value>> {
        let (c, s) = (part.config.as_str(), part.split.as_str());
        let total = || num_rows.ok_or_else(|| Error::invalid(format!("Hugging Face does not report how many rows {s} has; pick first rows or a range")));
        match &part.selection {
            HfSelection::Full => self.range(dataset, c, s, 0, total()?, on_rows).await,
            HfSelection::First { n } => self.range(dataset, c, s, 0, (*n).min(num_rows.unwrap_or(*n)), on_rows).await,
            HfSelection::Range { offset, n } => {
                let n = num_rows.map_or(*n, |t| (*n).min(t.saturating_sub(*offset)));
                self.range(dataset, c, s, *offset, n, on_rows).await
            }
            HfSelection::Random { n, seed } => {
                let picks = sample_indices(total()?, *n, *seed);
                // Nearby picks share a request: windows of up to PAGE rows.
                let mut windows: Vec<(usize, usize)> = Vec::new();
                for &i in &picks {
                    match windows.last_mut() {
                        Some((start, end)) if i < *start + PAGE => *end = i,
                        _ => windows.push((i, i)),
                    }
                }
                let picks: BTreeSet<usize> = picks.into_iter().collect();
                let mut out: Vec<(usize, Vec<Value>)> = stream::iter(windows)
                    .map(|(start, end)| {
                        let picks = &picks;
                        async move {
                            let (rows, _) = self.page("rows", dataset, c, s, start, end - start + 1, &[]).await?;
                            let keep: Vec<Value> = rows.into_iter().enumerate().filter(|(k, _)| picks.contains(&(start + k))).map(|(_, r)| r).collect();
                            on_rows(keep.len());
                            Ok::<_, Error>((start, keep))
                        }
                    })
                    .buffer_unordered(PARALLEL)
                    .try_collect()
                    .await?;
                out.sort_by_key(|(o, _)| *o);
                Ok(out.into_iter().flat_map(|(_, r)| r).collect())
            }
            HfSelection::Filter { clause, n } => self.matches("filter", dataset, c, s, &[("where", clause.clone())], *n, on_rows).await,
            HfSelection::Search { query, n } => self.matches("search", dataset, c, s, &[("query", query.clone())], *n, on_rows).await,
        }
    }

    /// Fetch every part and shape the tables to insert. `progress` is called as rows arrive;
    /// `cancel` stops between requests.
    pub async fn import(&self, spec: &HfImportSpec, info: &HfInfo, progress: impl Fn(HfProgress) + Sync, cancel: &AtomicBool) -> Result<Vec<HfTable>> {
        if spec.parts.is_empty() {
            return Err(Error::invalid("choose at least one split to import"));
        }
        let mut planned = 0usize;
        let mut plans = Vec::new();
        for part in &spec.parts {
            let config = info
                .configs
                .iter()
                .find(|c| c.config == part.config)
                .ok_or_else(|| Error::invalid(format!("no config \"{}\"", part.config)))?;
            let num_rows = config.splits.iter().find(|s| s.split == part.split).and_then(|s| s.num_rows);
            let want = planned_rows(&part.selection, num_rows);
            planned += want;
            plans.push((part, config, num_rows, want));
        }
        if planned > MAX_ROWS {
            return Err(Error::invalid(format!(
                "that is {planned} rows; ClassifAI imports up to {MAX_ROWS} at once — take a subset"
            )));
        }

        let configs: BTreeSet<&str> = spec.parts.iter().map(|p| p.config.as_str()).collect();
        let label = |p: &HfPart| if configs.len() > 1 { format!("{}/{}", p.config, p.split) } else { p.split.clone() };
        let mut tables: Vec<(String, String, Vec<String>, Vec<Row>)> = Vec::new();
        for (i, (part, config, num_rows, want)) in plans.iter().enumerate() {
            let done = std::sync::atomic::AtomicUsize::new(0);
            let on_rows = |k: usize| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let d = done.fetch_add(k, Ordering::Relaxed) + k;
                progress(HfProgress { part: i, parts: plans.len(), label: label(part), done: d, total: *want });
            };
            progress(HfProgress { part: i, parts: plans.len(), label: label(part), done: 0, total: *want });
            let rows = self.part_rows(&info.dataset, part, *num_rows, &on_rows).await?;
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::invalid("import cancelled"));
            }
            let keep: Vec<&HfFeature> =
                config.features.iter().filter(|f| spec.columns.is_empty() || spec.columns.contains(&f.name)).collect();
            let mut columns: Vec<String> = keep.iter().map(|f| f.name.clone()).collect();
            if columns.is_empty() {
                columns = rows.first().and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
            }
            let rows = rows.iter().map(|r| to_row(r, &columns, &keep)).collect();
            tables.push((label(part), format!("hf://datasets/{}/{}/{}", info.dataset, part.config, part.split), columns, rows));
        }

        let short = info.dataset.rsplit('/').next().unwrap_or(&info.dataset).to_string();
        let base = spec.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&short).to_string();
        if spec.combine && tables.len() > 1 {
            let mut columns: Vec<String> = Vec::new();
            for (_, _, cols, _) in &tables {
                for c in cols {
                    if !columns.contains(c) {
                        columns.push(c.clone());
                    }
                }
            }
            let split_col = if columns.iter().any(|c| c == "split") { "hf_split".to_string() } else { "split".to_string() };
            let rows = tables
                .iter()
                .flat_map(|(label, _, _, rows)| {
                    rows.iter().map(|r| {
                        let mut row: Row = columns.iter().map(|c| (c.clone(), r.get(c).cloned().unwrap_or_default())).collect();
                        row.insert(split_col.clone(), label.clone());
                        row
                    })
                })
                .collect();
            columns.push(split_col);
            return Ok(vec![HfTable {
                name: base,
                source: format!("hf://datasets/{}", info.dataset),
                data: ParsedDataset { columns, rows },
            }]);
        }
        let single = tables.len() == 1;
        Ok(tables
            .into_iter()
            .map(|(label, source, columns, rows)| HfTable {
                name: if single && spec.name.is_some() { base.clone() } else { format!("{base} · {label}") },
                source,
                data: ParsedDataset { columns, rows },
            })
            .collect())
    }
}

/// Rows a selection will import at most (filters and searches: their limit).
pub fn planned_rows(sel: &HfSelection, num_rows: Option<usize>) -> usize {
    let cap = |n: usize| num_rows.map_or(n, |t| n.min(t));
    match sel {
        HfSelection::Full => num_rows.unwrap_or(0),
        HfSelection::First { n } | HfSelection::Random { n, .. } | HfSelection::Filter { n, .. } | HfSelection::Search { n, .. } => cap(*n),
        HfSelection::Range { offset, n } => num_rows.map_or(*n, |t| (*n).min(t.saturating_sub(*offset))),
    }
}

fn feature(name: &str, t: &Value) -> HfFeature {
    let ty = t["_type"].as_str().unwrap_or("");
    let kind = match ty {
        "Value" => t["dtype"].as_str().unwrap_or("value").to_string(),
        "" if t.is_array() => "list".to_string(),
        "" => "struct".to_string(),
        other => other.to_string(),
    };
    let labels = (ty == "ClassLabel")
        .then(|| t["names"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()))
        .flatten();
    HfFeature { name: name.to_string(), kind, labels }
}

/// A row as text cells: class labels by name, images and audio by URL, nested values as JSON.
fn to_row(r: &Value, columns: &[String], features: &[&HfFeature]) -> Row {
    columns
        .iter()
        .map(|c| {
            let v = &r[c];
            let f = features.iter().find(|f| &f.name == c);
            let cell = match (f.and_then(|f| f.labels.as_ref()), v) {
                (Some(names), Value::Number(n)) => n
                    .as_u64()
                    .and_then(|i| names.get(i as usize).cloned())
                    .unwrap_or_default(), // -1 means "no label"
                _ => match v {
                    Value::Object(o) if o.contains_key("src") => o["src"].as_str().unwrap_or("").to_string(),
                    Value::Array(a) if a.first().is_some_and(|x| x.get("src").is_some()) => {
                        a.iter().filter_map(|x| x["src"].as_str()).collect::<Vec<_>>().join(" ")
                    }
                    other => value_to_cell(other),
                },
            };
            (c.clone(), cell)
        })
        .collect()
}

/// `n` distinct indices of `0..total`, sorted; the same seed gives the same sample.
pub fn sample_indices(total: usize, n: usize, seed: u64) -> Vec<usize> {
    let n = n.min(total);
    let mut state = seed ^ 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    // Floyd's algorithm: n draws, no array of size `total`.
    let mut picked = BTreeSet::new();
    for j in (total - n)..total {
        let t = (next() % (j as u64 + 1)) as usize;
        if !picked.insert(t) {
            picked.insert(j);
        }
    }
    picked.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dataset_refs() {
        assert_eq!(parse_dataset_ref("stanfordnlp/imdb").unwrap(), "stanfordnlp/imdb");
        assert_eq!(parse_dataset_ref("https://huggingface.co/datasets/stanfordnlp/imdb/viewer/plain_text/train").unwrap(), "stanfordnlp/imdb");
        assert_eq!(parse_dataset_ref("hf://datasets/nyu-mll/glue").unwrap(), "nyu-mll/glue");
        assert_eq!(parse_dataset_ref(" imdb ").unwrap(), "imdb");
        assert!(parse_dataset_ref("not a name").is_err());
    }

    #[test]
    fn random_samples_are_distinct_sorted_and_seeded() {
        let a = sample_indices(25_000, 500, 7);
        assert_eq!(a.len(), 500);
        assert!(a.windows(2).all(|w| w[0] < w[1]) && *a.last().unwrap() < 25_000);
        assert_eq!(a, sample_indices(25_000, 500, 7));
        assert_ne!(a, sample_indices(25_000, 500, 8));
        assert_eq!(sample_indices(5, 10, 1), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn rows_use_label_names_and_media_urls() {
        let label = HfFeature { name: "label".into(), kind: "ClassLabel".into(), labels: Some(vec!["neg".into(), "pos".into()]) };
        let text = HfFeature { name: "text".into(), kind: "string".into(), labels: None };
        let cols = vec!["text".to_string(), "label".to_string(), "image".to_string()];
        let r = to_row(&json!({ "text": "hi", "label": 1, "image": { "src": "https://x/img.png", "height": 3 } }), &cols, &[&text, &label]);
        assert_eq!((r["text"].as_str(), r["label"].as_str(), r["image"].as_str()), ("hi", "pos", "https://x/img.png"));
        assert_eq!(to_row(&json!({ "label": -1 }), &cols[1..2], &[&label])["label"], "");
    }

    #[test]
    fn planned_rows_cap_at_the_split() {
        assert_eq!(planned_rows(&HfSelection::Full, Some(10)), 10);
        assert_eq!(planned_rows(&HfSelection::Random { n: 50, seed: 1 }, Some(10)), 10);
        assert_eq!(planned_rows(&HfSelection::Range { offset: 8, n: 5 }, Some(10)), 2);
    }

    /// Hits the real API: `cargo test -p classifai-core hf_live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn hf_live() {
        let hf = HfClient::new(None);
        let info = hf.info("stanfordnlp/imdb").await.unwrap();
        let train = info.configs[0].splits.iter().find(|s| s.split == "train").unwrap();
        assert_eq!(train.num_rows, Some(25_000));
        let spec = HfImportSpec {
            dataset: info.dataset.clone(),
            parts: vec![
                HfPart { config: "plain_text".into(), split: "train".into(), selection: HfSelection::Random { n: 150, seed: 3 } },
                HfPart { config: "plain_text".into(), split: "test".into(), selection: HfSelection::First { n: 120 } },
            ],
            combine: true,
            name: None,
            columns: vec![],
        };
        let t = hf.import(&spec, &info, |_| {}, &AtomicBool::new(false)).await.unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].data.columns, ["text", "label", "split"]);
        assert_eq!(t[0].data.rows.len(), 270);
        assert!(["neg", "pos"].contains(&t[0].data.rows[0]["label"].as_str()));
    }
}
