//! Metrics over stored predictions.

use indexmap::IndexMap;
use serde::Serialize;

use crate::store::Prediction;

#[derive(Debug, Clone, Serialize)]
pub struct ClassMetrics {
    pub label: String,
    pub support: usize,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalibrationBin {
    pub lower: f64,
    pub upper: f64,
    pub count: usize,
    pub mean_confidence: f64,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelMetrics {
    pub model: String,
    /// predictions stored, including errors
    pub evaluated: usize,
    pub errors: usize,
    pub accuracy: f64,
    pub macro_precision: f64,
    pub macro_recall: f64,
    pub macro_f1: f64,
    pub weighted_f1: f64,
    pub mean_confidence: f64,
    /// Expected calibration error over 10 equal-width bins of the top probability.
    pub ece: f64,
    pub latency_p50_ms: f64,
    pub latency_p95_ms: f64,
    pub latency_mean_ms: f64,
    pub per_class: Vec<ClassMetrics>,
    /// confusion[i][j] = rows with ground truth labels[i] predicted as labels[j]
    pub confusion: Vec<Vec<usize>>,
    pub calibration: Vec<CalibrationBin>,
    /// Cohen's kappa between predictions and ground truth over answered rows.
    pub kappa: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// The question (task id) these metrics are for.
    pub question_id: String,
    pub labels: Vec<String>,
    pub models: Vec<ModelMetrics>,
    /// agreement[i][j] = share of rows where models i and j predicted the same label
    pub agreement: Vec<Vec<f64>>,
    /// pairwise_kappa[i][j] = Cohen's kappa between models i and j on rows both answered (diagonal 1).
    pub pairwise_kappa: Vec<Vec<f64>>,
    /// Fleiss' kappa over rows every model answered; None with fewer than 2 models or no such rows.
    pub fleiss_kappa: Option<f64>,
    /// Rows of this question whose ground truth a human corrected or confirmed (set by
    /// [`crate::analysis::report`]; 0 here).
    pub reviewed_rows: usize,
}

/// Metrics for one question; `predictions` should be that question's only.
pub fn report(question_id: &str, labels: &[String], models: &[String], predictions: &[Prediction]) -> Report {
    let mut by_model: IndexMap<&str, Vec<&Prediction>> = models.iter().map(|m| (m.as_str(), vec![])).collect();
    for p in predictions {
        by_model.entry(p.model.as_str()).or_default().push(p);
    }
    let metrics: Vec<ModelMetrics> = by_model.iter().map(|(m, ps)| model_metrics(m, labels, ps)).collect();

    // pairwise agreement on rows both models answered
    let maps: Vec<IndexMap<usize, &str>> = by_model
        .values()
        .map(|ps| ps.iter().filter_map(|p| Some((p.row_idx, p.predicted.as_deref()?))).collect())
        .collect();
    let pairwise_kappa = maps
        .iter()
        .enumerate()
        .map(|(i, a)| {
            maps.iter()
                .enumerate()
                .map(|(j, b)| {
                    if i == j {
                        return 1.0;
                    }
                    let pairs: Vec<(&str, &str)> = a.iter().filter_map(|(k, va)| Some((*va, *b.get(k)?))).collect();
                    cohen_kappa(&pairs)
                })
                .collect()
        })
        .collect();
    let fleiss_kappa = (maps.len() >= 2).then(|| fleiss_from_maps(labels, &maps)).flatten();
    let agreement = maps
        .iter()
        .map(|a| {
            maps.iter()
                .map(|b| {
                    let (mut same, mut both) = (0usize, 0usize);
                    for (k, va) in a {
                        if let Some(vb) = b.get(k) {
                            both += 1;
                            same += (va == vb) as usize;
                        }
                    }
                    ratio(same, both)
                })
                .collect()
        })
        .collect();

    Report {
        question_id: question_id.to_string(),
        labels: labels.to_vec(),
        models: metrics,
        agreement,
        pairwise_kappa,
        fleiss_kappa,
        reviewed_rows: 0,
    }
}

/// Cohen's kappa of paired ratings, with chance agreement from the observed marginals.
/// Perfect chance agreement (both raters constant) gives 1 when they agree, else 0; no pairs give 0.
pub fn cohen_kappa(pairs: &[(&str, &str)]) -> f64 {
    if pairs.is_empty() {
        return 0.0;
    }
    let n = pairs.len() as f64;
    let mut a: IndexMap<&str, f64> = IndexMap::new();
    let mut b: IndexMap<&str, f64> = IndexMap::new();
    let mut agree = 0.0;
    for &(x, y) in pairs {
        *a.entry(x).or_default() += 1.0;
        *b.entry(y).or_default() += 1.0;
        if x == y {
            agree += 1.0;
        }
    }
    let po = agree / n;
    let pe: f64 = a.iter().map(|(k, ca)| ca / n * b.get(k).copied().unwrap_or(0.0) / n).sum();
    if (1.0 - pe).abs() < 1e-12 {
        return if (po - 1.0).abs() < 1e-12 { 1.0 } else { 0.0 };
    }
    (po - pe) / (1.0 - pe)
}

/// Fleiss' kappa from a subjects x categories count table with the same number of raters
/// (at least 2) per subject. None for an empty table.
pub fn fleiss_kappa(counts: &[Vec<usize>]) -> Option<f64> {
    let first = counts.first()?;
    let n: usize = first.iter().sum();
    if n < 2 || counts.iter().any(|r| r.iter().sum::<usize>() != n) {
        return None;
    }
    let (subjects, raters) = (counts.len() as f64, n as f64);
    let k = first.len();
    let p_bar = counts
        .iter()
        .map(|r| (r.iter().map(|&c| (c * c) as f64).sum::<f64>() - raters) / (raters * (raters - 1.0)))
        .sum::<f64>()
        / subjects;
    let pe: f64 = (0..k)
        .map(|j| {
            let pj = counts.iter().map(|r| r[j] as f64).sum::<f64>() / (subjects * raters);
            pj * pj
        })
        .sum();
    if (1.0 - pe).abs() < 1e-12 {
        return Some(if (p_bar - 1.0).abs() < 1e-12 { 1.0 } else { 0.0 });
    }
    Some((p_bar - pe) / (1.0 - pe))
}

/// Fleiss' kappa over the rows every model answered. Predictions outside `labels` get their own
/// category.
fn fleiss_from_maps(labels: &[String], maps: &[IndexMap<usize, &str>]) -> Option<f64> {
    let mut cats: IndexMap<&str, usize> = labels.iter().enumerate().map(|(i, l)| (l.as_str(), i)).collect();
    let (first, rest) = maps.split_first()?;
    let mut rows: Vec<Vec<&str>> = Vec::new();
    for (idx, v) in first {
        let others: Option<Vec<&str>> = rest.iter().map(|m| m.get(idx).copied()).collect();
        if let Some(others) = others {
            rows.push(std::iter::once(*v).chain(others).collect());
        }
    }
    for v in rows.iter().flatten() {
        let next = cats.len();
        cats.entry(v).or_insert(next);
    }
    let counts: Vec<Vec<usize>> = rows
        .iter()
        .map(|r| {
            let mut c = vec![0usize; cats.len()];
            for v in r {
                c[cats[v]] += 1;
            }
            c
        })
        .collect();
    fleiss_kappa(&counts)
}

fn model_metrics(model: &str, labels: &[String], ps: &[&Prediction]) -> ModelMetrics {
    let k = labels.len();
    let index: IndexMap<&str, usize> = labels.iter().enumerate().map(|(i, l)| (l.as_str(), i)).collect();
    let mut confusion = vec![vec![0usize; k]; k];
    let mut errors = 0;
    let mut correct = 0;
    let mut answered = 0;
    let mut conf_sum = 0.0;
    let mut latencies: Vec<f64> = Vec::new();
    let mut calib: Vec<(f64, bool)> = Vec::new();
    let mut pairs: Vec<(&str, &str)> = Vec::new();

    for p in ps {
        if let Some(l) = p.latency_ms {
            latencies.push(l);
        }
        let Some(pred) = p.predicted.as_deref() else {
            errors += 1;
            continue;
        };
        answered += 1;
        pairs.push((p.ground_truth.as_str(), pred));
        let hit = pred == p.ground_truth;
        correct += hit as usize;
        conf_sum += p.confidence.unwrap_or(0.0);
        if let Some(tp) = p.top_prob {
            calib.push((tp, hit));
        }
        if let (Some(&i), Some(&j)) = (index.get(p.ground_truth.as_str()), index.get(pred)) {
            confusion[i][j] += 1;
        }
    }

    let per_class: Vec<ClassMetrics> = labels
        .iter()
        .enumerate()
        .map(|(i, label)| {
            let tp = confusion[i][i];
            let support: usize = confusion[i].iter().sum();
            let predicted: usize = confusion.iter().map(|r| r[i]).sum();
            let precision = ratio(tp, predicted);
            let recall = ratio(tp, support);
            let f1 = if precision + recall > 0.0 { 2.0 * precision * recall / (precision + recall) } else { 0.0 };
            ClassMetrics { label: label.clone(), support, precision, recall, f1 }
        })
        .collect();

    // macro averages over classes present in ground truth
    let present: Vec<&ClassMetrics> = per_class.iter().filter(|c| c.support > 0).collect();
    let n_present = present.len().max(1) as f64;
    let total_support: usize = present.iter().map(|c| c.support).sum();
    let macro_precision = present.iter().map(|c| c.precision).sum::<f64>() / n_present;
    let macro_recall = present.iter().map(|c| c.recall).sum::<f64>() / n_present;
    let macro_f1 = present.iter().map(|c| c.f1).sum::<f64>() / n_present;
    let weighted_f1 = if total_support > 0 {
        present.iter().map(|c| c.f1 * c.support as f64).sum::<f64>() / total_support as f64
    } else {
        0.0
    };

    let (calibration, ece) = calibration_bins(&calib);
    latencies.sort_by(|a, b| a.total_cmp(b));

    ModelMetrics {
        model: model.to_string(),
        evaluated: ps.len(),
        errors,
        accuracy: ratio(correct, answered),
        macro_precision,
        macro_recall,
        macro_f1,
        weighted_f1,
        mean_confidence: if answered > 0 { conf_sum / answered as f64 } else { 0.0 },
        ece,
        latency_p50_ms: percentile(&latencies, 0.5),
        latency_p95_ms: percentile(&latencies, 0.95),
        latency_mean_ms: if latencies.is_empty() { 0.0 } else { latencies.iter().sum::<f64>() / latencies.len() as f64 },
        per_class,
        confusion,
        calibration,
        kappa: cohen_kappa(&pairs),
    }
}

fn calibration_bins(points: &[(f64, bool)]) -> (Vec<CalibrationBin>, f64) {
    const BINS: usize = 10;
    let mut sums = vec![(0usize, 0.0f64, 0usize); BINS];
    for &(p, hit) in points {
        let b = ((p * BINS as f64) as usize).min(BINS - 1);
        sums[b].0 += 1;
        sums[b].1 += p;
        sums[b].2 += hit as usize;
    }
    let n = points.len().max(1) as f64;
    let mut ece = 0.0;
    let bins = sums
        .iter()
        .enumerate()
        .map(|(i, &(count, psum, hits))| {
            let mean_confidence = if count > 0 { psum / count as f64 } else { 0.0 };
            let accuracy = ratio(hits, count);
            ece += (count as f64 / n) * (accuracy - mean_confidence).abs();
            CalibrationBin {
                lower: i as f64 / BINS as f64,
                upper: (i + 1) as f64 / BINS as f64,
                count,
                mean_confidence,
                accuracy,
            }
        })
        .collect();
    (bins, ece)
}

fn ratio(a: usize, b: usize) -> f64 {
    if b == 0 { 0.0 } else { a as f64 / b as f64 }
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let pos = q * (sorted.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(model: &str, idx: usize, gt: &str, pred: Option<&str>, tp: f64) -> Prediction {
        Prediction {
            model: model.into(),
            row_idx: idx,
            question_id: "q".into(),
            ground_truth: gt.into(),
            predicted: pred.map(Into::into),
            confidence: Some(tp),
            top_prob: Some(tp),
            probabilities: None,
            latency_ms: Some(10.0 * (idx + 1) as f64),
            error: pred.is_none().then(|| "boom".into()),
        }
    }

    #[test]
    fn metrics_match_hand_computation() {
        let labels = vec!["a".to_string(), "b".to_string()];
        let models = vec!["m1".to_string(), "m2".to_string()];
        let preds = vec![
            p("m1", 0, "a", Some("a"), 0.9),
            p("m1", 1, "a", Some("b"), 0.6),
            p("m1", 2, "b", Some("b"), 0.8),
            p("m1", 3, "b", None, 0.0),
            p("m2", 0, "a", Some("a"), 0.9),
            p("m2", 1, "a", Some("a"), 0.9),
            p("m2", 2, "b", Some("a"), 0.7),
        ];
        let r = report("q", &labels, &models, &preds);
        assert_eq!(r.question_id, "q");
        let m1 = &r.models[0];
        assert_eq!(m1.errors, 1);
        assert!((m1.accuracy - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(m1.confusion, vec![vec![1, 1], vec![0, 1]]);
        // class a: p=1, r=.5, f1=.667; class b: p=.5, r=1, f1=.667
        assert!((m1.macro_f1 - 2.0 / 3.0).abs() < 1e-9);
        // m1 vs m2 agree on rows 0 only out of 0,1,2
        assert!((r.agreement[0][1] - 1.0 / 3.0).abs() < 1e-9);
        assert!((r.agreement[0][0] - 1.0).abs() < 1e-9);
        assert!((m1.latency_p50_ms - 25.0).abs() < 1e-9);
        // m1 vs truth on rows 0..2: (a,a) (a,b) (b,b): po = 2/3, pe = 2/3*1/3 + 1/3*2/3 = 4/9 → κ = 0.4
        assert!((m1.kappa - 0.4).abs() < 1e-9, "{}", m1.kappa);
        // m2 predicts a always: pe = 2/3, po = 2/3 → κ = 0
        assert!(r.models[1].kappa.abs() < 1e-9);
        // m1 (a,b,b) vs m2 (a,a,a) on rows 0..2: po 1/3, pe = 1/3 → 0
        assert!(r.pairwise_kappa[0][1].abs() < 1e-9);
        assert_eq!(r.pairwise_kappa[1][1], 1.0);
        // all rows answered by both: 0,1,2 → counts per row [2,0] [1,1] [1,1]
        // P̄ = (1 + 0 + 0)/3 = 1/3; p_a = 4/6, p_b = 2/6 → P̄e = 5/9; κ = (1/3-5/9)/(4/9) = -0.5
        assert!((r.fleiss_kappa.unwrap() + 0.5).abs() < 1e-9, "{:?}", r.fleiss_kappa);
        assert_eq!(r.reviewed_rows, 0);
        let single = report("q", &labels, &models[..1], &preds[..4]);
        assert_eq!(single.fleiss_kappa, None);
    }

    #[test]
    fn cohen_kappa_textbook_example() {
        // Wikipedia: 50 proposals, both yes 20, A yes B no 5, A no B yes 10, both no 15 → κ = 0.4
        let mut pairs = Vec::new();
        pairs.extend(std::iter::repeat_n(("yes", "yes"), 20));
        pairs.extend(std::iter::repeat_n(("yes", "no"), 5));
        pairs.extend(std::iter::repeat_n(("no", "yes"), 10));
        pairs.extend(std::iter::repeat_n(("no", "no"), 15));
        assert!((cohen_kappa(&pairs) - 0.4).abs() < 1e-9);
        assert_eq!(cohen_kappa(&[("a", "a"), ("a", "a")]), 1.0, "constant raters that agree");
        assert_eq!(cohen_kappa(&[]), 0.0);
    }

    #[test]
    fn fleiss_kappa_textbook_example() {
        // Wikipedia / Fleiss (1971): 10 subjects, 14 raters, 5 categories → κ ≈ 0.210
        let t = vec![
            vec![0, 0, 0, 0, 14],
            vec![0, 2, 6, 4, 2],
            vec![0, 0, 3, 5, 6],
            vec![0, 3, 9, 2, 0],
            vec![2, 2, 8, 1, 1],
            vec![7, 7, 0, 0, 0],
            vec![3, 2, 6, 3, 0],
            vec![2, 5, 3, 2, 2],
            vec![6, 5, 2, 1, 0],
            vec![0, 2, 2, 3, 7],
        ];
        let k = fleiss_kappa(&t).unwrap();
        assert!((k - 0.20993).abs() < 1e-4, "{k}");
        assert_eq!(fleiss_kappa(&[]), None);
        assert_eq!(fleiss_kappa(&[vec![2, 0], vec![0, 2]]), Some(1.0));
    }
}
