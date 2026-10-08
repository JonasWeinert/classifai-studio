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
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub labels: Vec<String>,
    pub models: Vec<ModelMetrics>,
    /// agreement[i][j] = share of rows where models i and j predicted the same label
    pub agreement: Vec<Vec<f64>>,
}

pub fn report(labels: &[String], models: &[String], predictions: &[Prediction]) -> Report {
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

    Report { labels: labels.to_vec(), models: metrics, agreement }
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

    for p in ps {
        if let Some(l) = p.latency_ms {
            latencies.push(l);
        }
        let Some(pred) = p.predicted.as_deref() else {
            errors += 1;
            continue;
        };
        answered += 1;
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
        let r = report(&labels, &models, &preds);
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
    }
}
