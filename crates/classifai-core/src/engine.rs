//! Locate, install, start and stop the Ollaya engine.
//!
//! ClassifAI installs its own copy of Ollaya into `<app data>/engine` with the official install
//! script (`OLLAYA_INSTALL_DIR`, no sudo, no system service). An Ollaya that is already installed
//! on the machine, or a daemon that is already running, is used as-is.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::ollaya::Client;
use crate::{Error, Result};

pub const INSTALL_SCRIPT_URL: &str = "https://ollaya.dev/install.sh";

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    /// true when the binary is ClassifAI's own copy under the app data directory
    pub managed: bool,
    pub running: bool,
    /// true when this app started the daemon (and will stop it on exit)
    pub owned_process: bool,
    pub version: Option<String>,
    pub base_url: String,
}

pub struct Engine {
    prefix: PathBuf,
    log_dir: PathBuf,
    client: Client,
    child: Mutex<Option<Child>>,
}

impl Engine {
    /// `data_dir` is the app's data directory; the engine lives in `data_dir/engine`.
    pub fn new(data_dir: &Path, client: Client) -> Self {
        Self {
            prefix: data_dir.join("engine"),
            log_dir: data_dir.join("logs"),
            client,
            child: Mutex::new(None),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn managed_binary(&self) -> PathBuf {
        self.prefix.join("bin").join(exe("ollaya"))
    }

    /// The managed copy first, then the usual install locations. GUI apps on macOS do not inherit
    /// the shell's PATH, so the common prefixes are checked explicitly.
    pub fn find_binary(&self) -> Option<(PathBuf, bool)> {
        let managed = self.managed_binary();
        if managed.is_file() {
            return Some((managed, true));
        }
        let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).map(|d| d.join(exe("ollaya"))).collect())
            .unwrap_or_default();
        candidates.push("/usr/local/bin/ollaya".into());
        candidates.push("/opt/homebrew/bin/ollaya".into());
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(Path::new(&home).join(".local/bin/ollaya"));
        }
        candidates.into_iter().find(|p| p.is_file()).map(|p| (p, false))
    }

    pub async fn status(&self) -> EngineStatus {
        let found = self.find_binary();
        let running = self.client.is_alive().await;
        let version = if running { self.client.version().await.ok() } else { None };
        let owned_process = {
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(None)),
                None => false,
            }
        };
        EngineStatus {
            installed: found.is_some(),
            binary_path: found.as_ref().map(|(p, _)| p.display().to_string()),
            managed: found.map(|(_, m)| m).unwrap_or(false),
            running,
            owned_process,
            version,
            base_url: self.client.base_url().to_string(),
        }
    }

    /// Download and run Ollaya's install script into the app's own prefix. Every output line is
    /// passed to `on_line`.
    pub async fn install(&self, mut on_line: impl FnMut(String) + Send) -> Result<()> {
        if cfg!(windows) {
            return Err(Error::invalid(
                "Automatic install is not supported on Windows yet. Run `irm https://ollaya.dev/install.ps1 | iex` in PowerShell, then restart ClassifAI.",
            ));
        }
        tokio::fs::create_dir_all(&self.prefix).await?;
        on_line(format!("Downloading {INSTALL_SCRIPT_URL}"));
        let script = reqwest::get(INSTALL_SCRIPT_URL).await?.error_for_status()?.text().await?;
        let script_path = self.prefix.join("install.sh");
        tokio::fs::write(&script_path, script).await?;

        let mut child = Command::new("sh")
            .arg(&script_path)
            .env("OLLAYA_INSTALL_DIR", &self.prefix)
            .env("OLLAYA_NO_SERVICE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx.send(l);
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx2.send(l);
            }
        });
        while let Some(line) = rx.recv().await {
            on_line(strip_ansi(&line));
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(Error::invalid(format!("Ollaya installer exited with {status}")));
        }
        if !self.managed_binary().is_file() {
            return Err(Error::invalid("installer finished but the ollaya binary was not found"));
        }
        on_line("Ollaya installed.".into());
        Ok(())
    }

    /// Start `ollaya serve` unless a daemon already answers. Waits until it is healthy.
    pub async fn start(&self) -> Result<()> {
        if self.client.is_alive().await {
            return Ok(());
        }
        let (bin, _) = self.find_binary().ok_or(Error::EngineNotInstalled)?;
        tokio::fs::create_dir_all(&self.log_dir).await?;
        let child = Command::new(bin)
            .arg("serve")
            .env("OLLAYA_LOG_DIR", &self.log_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        *self.child.lock().await = Some(child);

        for _ in 0..60 {
            if self.client.is_alive().await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(Error::invalid(format!(
            "Ollaya did not come up within 15 s; see {}",
            self.log_dir.join("server.log").display()
        )))
    }

    /// Stop the daemon if this app started it. A daemon started elsewhere is left alone.
    pub async fn stop(&self) -> Result<()> {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // skip ESC [ ... final-byte
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn strips_ansi() {
        assert_eq!(super::strip_ansi("\u{1b}[1m>>>\u{1b}[0m hi"), ">>> hi");
    }
}
