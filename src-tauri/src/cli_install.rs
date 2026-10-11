//! Installing the `classifai` command line tool: a symlink in /usr/local/bin to the copy bundled
//! in the app (`Contents/MacOS/classifai`), like VS Code's "Install 'code' command". macOS asks for
//! an administrator password when /usr/local/bin is not writable. The link points into the app, so
//! updating the app updates the command; moving the app breaks the link, which `status` reports.

use std::path::{Path, PathBuf};

use classifai_core::{Error, Result};
use serde::Serialize;

pub const TARGET: &str = "/usr/local/bin/classifai";

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliState {
    /// The link points at this app's copy.
    Installed,
    /// Nothing at the target.
    NotInstalled,
    /// A link to a copy that no longer exists (the app was moved or deleted).
    Broken,
    /// Something else is at the target: another `classifai`, or an older app's link.
    Other,
    /// This build has no bundled CLI (in development, build it with `cargo build -p classifai-cli`).
    Unavailable,
}

#[derive(Debug, Serialize)]
pub struct CliStatus {
    pub state: CliState,
    pub target: String,
    /// The bundled CLI, when there is one.
    pub source: Option<String>,
    /// What the target points to, when it is a link.
    pub points_to: Option<String>,
    /// Whether terminals have /usr/local/bin on their PATH (from /etc/paths, as macOS sets it up).
    pub on_path: bool,
}

/// The CLI next to the app's executable: Contents/MacOS in the bundle, target/<profile> in development.
fn source() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("classifai");
    p.is_file().then_some(p)
}

fn on_path() -> bool {
    std::fs::read_to_string("/etc/paths").map(|s| s.lines().any(|l| l.trim() == "/usr/local/bin")).unwrap_or(false)
        || std::env::var("PATH").is_ok_and(|p| p.split(':').any(|d| d == "/usr/local/bin"))
}

pub fn status() -> CliStatus {
    let target = Path::new(TARGET);
    let src = source();
    let link = std::fs::read_link(target).ok();
    let state = if src.is_none() {
        CliState::Unavailable
    } else if let Some(l) = &link {
        let same = src.as_ref().is_some_and(|s| std::fs::canonicalize(l).ok() == std::fs::canonicalize(s).ok());
        if same {
            CliState::Installed
        } else if !target.exists() {
            CliState::Broken
        } else {
            CliState::Other
        }
    } else if target.symlink_metadata().is_ok() {
        CliState::Other
    } else {
        CliState::NotInstalled
    };
    CliStatus {
        state,
        target: TARGET.into(),
        source: src.map(|s| s.display().to_string()),
        points_to: link.map(|l| l.display().to_string()),
        on_path: on_path(),
    }
}

/// A string as an AppleScript string literal.
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Run a shell command as administrator; macOS shows its own password prompt.
fn run_as_admin(shell: &str) -> Result<()> {
    let script = format!(
        "do shell script {} with administrator privileges with prompt \"ClassifAI Studio wants to install the classifai command in /usr/local/bin.\"",
        applescript_string(shell)
    );
    let out = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).output().map_err(Error::Io)?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-128") {
        return Err(Error::invalid("Cancelled. The command line tool was not installed."));
    }
    Err(Error::invalid(format!("Could not change /usr/local/bin: {}", err.trim())))
}

/// A path for a shell command, in single quotes.
fn shell_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "'\\''"))
}

/// Link the bundled CLI into /usr/local/bin. `replace` also replaces a different `classifai`.
pub fn install(replace: bool) -> Result<CliStatus> {
    let src = source().ok_or_else(|| Error::invalid("This build has no bundled command line tool. In development, run: cargo build -p classifai-cli"))?;
    let target = Path::new(TARGET);
    if !replace && matches!(status().state, CliState::Other) {
        return Err(Error::invalid(format!("{TARGET} already exists and is not this app's command line tool")));
    }
    // Without a password when the folder is writable (e.g. a Homebrew setup on Intel Macs).
    let direct = (|| -> std::io::Result<()> {
        if target.symlink_metadata().is_ok() {
            std::fs::remove_file(target)?;
        }
        std::os::unix::fs::symlink(&src, target)
    })();
    if direct.is_err() {
        let s = src.display().to_string();
        run_as_admin(&format!("mkdir -p /usr/local/bin && ln -sfn {} {}", shell_quote(&s), shell_quote(TARGET)))?;
    }
    Ok(status())
}

/// Remove the link, only when it is this app's (or a broken one).
pub fn uninstall() -> Result<CliStatus> {
    match status().state {
        CliState::Installed | CliState::Broken => {}
        CliState::NotInstalled | CliState::Unavailable => return Ok(status()),
        CliState::Other => return Err(Error::invalid(format!("{TARGET} is not this app's command line tool; leaving it alone"))),
    }
    if std::fs::remove_file(TARGET).is_err() {
        run_as_admin(&format!("rm -f {}", shell_quote(TARGET)))?;
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("/Applications/ClassifAI Studio.app/x"), "'/Applications/ClassifAI Studio.app/x'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(applescript_string(r#"ln -s 'a "b"' c"#), r#""ln -s 'a \"b\"' c""#);
    }
}
