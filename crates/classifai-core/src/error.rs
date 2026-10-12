use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Ollaya engine is not reachable at {0}. Start it from the Engine page.")]
    EngineOffline(String),
    #[error("Ollaya engine is not installed")]
    EngineNotInstalled,
    #[error("{message} ({code})")]
    Api { status: u16, code: String, message: String },
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("could not read file: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not parse CSV: {0}")]
    Csv(#[from] csv::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("system keychain: {0}")]
    Keychain(String),
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Error::Invalid(msg.into())
    }
    pub fn code(&self) -> &str {
        match self {
            Error::EngineOffline(_) => "ENGINE_OFFLINE",
            Error::EngineNotInstalled => "ENGINE_NOT_INSTALLED",
            Error::Api { code, .. } => code,
            Error::Http(_) => "HTTP",
            Error::Db(_) => "DB",
            Error::Io(_) => "IO",
            Error::Csv(_) | Error::Json(_) => "PARSE",
            Error::Invalid(_) => "INVALID",
            Error::NotFound(_) => "NOT_FOUND",
            Error::Keychain(_) => "KEYCHAIN",
            Error::Cancelled => "CANCELLED",
        }
    }
}

/// Errors cross the Tauri boundary as `{ code, message }`.
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
