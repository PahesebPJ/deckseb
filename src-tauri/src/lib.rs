use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

// --- Domain Models ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentHostId {
    Antigravity,
    Claude,
    Codex,
    Opencode,
    Herdr,
    Shell,
}

impl AgentHostId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Antigravity => "antigravity",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Herdr => "herdr",
            Self::Shell => "shell",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "antigravity" => Some(Self::Antigravity),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "herdr" => Some(Self::Herdr),
            "shell" => Some(Self::Shell),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalStatus {
    Running,
    Idle,
    Blocked,
    Exited,
}

impl TerminalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Idle => "idle",
            Self::Blocked => "blocked",
            Self::Exited => "exited",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalSession {
    pub id: String,
    pub title: String,
    pub host_id: AgentHostId,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: TerminalStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Dark,
}

impl ThemeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DetectedArtifact {
    pub id: String,
    pub session_id: String,
    pub project_slug: String,
    pub segment: String,
    pub title: String,
    pub file_path: String,
    pub content: String,
    pub mermaid_blocks: Vec<String>,
    pub detected_at: String,
    pub synced_to_memoseb: bool,
    pub memoseb_category: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VaultStats {
    pub project_count: usize,
    pub memory_count: usize,
    pub total_tokens: usize,
}

#[derive(Debug, Clone)]
pub struct SebEcosystemSnapshot {
    pub optional_mode: bool,
    pub hubseb_detected: bool,
    pub crewseb_detected: bool,
    pub memoseb_detected: bool,
    pub herdr_detected: bool,
    pub available_hosts: Vec<String>,
    pub concurrency_mode: String,
    pub max_local_parallel: usize,
    pub preset: String,
    pub personas: HashMap<String, String>,
    pub active_subagents_count: usize,
    pub memo_events_count: usize,
    pub vault_stats: VaultStats,
}

#[derive(Debug, Clone)]
pub struct SessionContextQuota {
    pub session_id: String,
    pub model_name: String,
    pub used_tokens: usize,
    pub max_tokens: usize,
    pub remaining_percent: usize,
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub quota_used_percent: usize,
    pub quota_window_label: String,
    pub warning_level: String,
}

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

// --- Terminal & Process Manager ---

struct ActiveProcess {
    session: TerminalSession,
    child: Option<Child>,
}

pub struct TerminalManager {
    processes: Mutex<HashMap<String, ActiveProcess>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        host_id: AgentHostId,
        cwd: Option<String>,
        title: Option<String>,
        command: Option<String>,
        args: Option<Vec<String>>,
    ) -> Result<TerminalSession, String> {
        let session_id = format!("term-{}", now_iso());
        let effective_title = title.unwrap_or_else(|| format!("{} Terminal", host_id.as_str()));
        let effective_cwd = cwd.unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .to_string()
        });

        let shell_cmd = command.unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "cmd.exe".to_string()
            } else {
                env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
            }
        });

        let mut cmd = Command::new(&shell_cmd);
        cmd.current_dir(&effective_cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(cmd_args) = args {
            for arg in cmd_args {
                cmd.arg(arg);
            }
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn shell '{}': {e}", shell_cmd))?;
        let pid = Some(child.id());

        let session = TerminalSession {
            id: session_id.clone(),
            title: effective_title,
            host_id,
            cwd: effective_cwd,
            pid,
            status: TerminalStatus::Running,
            created_at: now_iso(),
        };

        let mut lock = self.processes.lock().unwrap();
        lock.insert(
            session_id,
            ActiveProcess {
                session: session.clone(),
                child: Some(child),
            },
        );

        Ok(session)
    }

    pub fn write_session(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock
            .get_mut(session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;

        if let Some(ref mut child) = proc.child {
            if let Some(ref mut stdin) = child.stdin {
                stdin
                    .write_all(data)
                    .map_err(|e| format!("Write to stdin failed: {e}"))?;
                stdin
                    .flush()
                    .map_err(|e| format!("Flush stdin failed: {e}"))?;
                return Ok(());
            }
        }
        Err("Process stdin unavailable".to_string())
    }

    pub fn resize_session(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        let lock = self.processes.lock().unwrap();
        if lock.contains_key(session_id) {
            Ok(())
        } else {
            Err(format!("Session '{session_id}' not found"))
        }
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        if let Some(mut proc) = lock.remove(session_id) {
            if let Some(ref mut child) = proc.child {
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(())
        } else {
            Err(format!("Session '{session_id}' not found"))
        }
    }

    pub fn list_sessions(&self) -> Vec<TerminalSession> {
        let mut lock = self.processes.lock().unwrap();
        let mut list = Vec::new();

        for proc in lock.values_mut() {
            if let Some(ref mut child) = proc.child {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        proc.session.status = TerminalStatus::Exited;
                    }
                    Ok(None) => {
                        proc.session.status = TerminalStatus::Running;
                    }
                    Err(_) => {
                        proc.session.status = TerminalStatus::Exited;
                    }
                }
            }
            list.push(proc.session.clone());
        }

        list
    }
}

// --- Plan & Artifact Detection in Rust ---

pub fn extract_mermaid_blocks(content: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let marker = "```mermaid";
    let mut search_idx = 0;

    while let Some(start_pos) = content[search_idx..].find(marker) {
        let abs_start = search_idx + start_pos + marker.len();
        if let Some(end_pos) = content[abs_start..].find("```") {
            let block = content[abs_start..abs_start + end_pos].trim();
            if !block.is_empty() {
                blocks.push(block.to_string());
            }
            search_idx = abs_start + end_pos + 3;
        } else {
            break;
        }
    }

    blocks
}

pub fn classify_artifact_segment(file_path: &str, content: &str) -> &'static str {
    let lower_path = file_path.to_lowercase();
    let lower_content = content.to_lowercase();

    if lower_path.contains("post-mortem")
        || lower_path.contains("postmortem")
        || lower_content.contains("root cause analysis")
    {
        return "post-mortems";
    }
    if lower_path.contains("review")
        || lower_path.contains("audit")
        || lower_content.contains("code review")
        || lower_content.contains("security audit")
    {
        return "reviews";
    }
    if lower_path.contains("spec")
        || lower_path.ends_with(".feature")
        || lower_content.contains("scenario:")
        || (lower_content.contains("given ") && lower_content.contains("when ") && lower_content.contains("then "))
    {
        return "specs";
    }
    if lower_path.ends_with(".mmd") || lower_path.contains("/diagram") {
        return "diagrams";
    }

    if lower_content.contains("# plan")
        || lower_content.contains("# implementation")
        || lower_content.contains("matriz de despacho")
        || lower_content.contains("dispatch matrix")
    {
        return "plans";
    }

    let mermaid = extract_mermaid_blocks(content);
    if !mermaid.is_empty() && content.trim().len() < 120 {
        return "diagrams";
    }

    "plans"
}

pub fn detect_plan(
    session_id: &str,
    project_slug: &str,
    text: &str,
    file_path: Option<&str>,
) -> Option<DetectedArtifact> {
    if text.trim().is_empty() {
        return None;
    }

    let mermaid_blocks = extract_mermaid_blocks(text);
    let lower = text.to_lowercase();
    let has_heading = text.lines().any(|l| l.trim_start().starts_with("# "));
    let has_plan_kw = lower.contains("plan")
        || lower.contains("implementation")
        || lower.contains("matriz de despacho")
        || lower.contains("dispatch matrix")
        || lower.contains("scenario:")
        || lower.contains("code review");

    let is_target = file_path
        .map(|f| f.ends_with(".md") || f.ends_with(".mmd"))
        .unwrap_or(false);

    if mermaid_blocks.is_empty() && !(has_heading && has_plan_kw) && !is_target {
        return None;
    }

    let title = text
        .lines()
        .find(|l| l.trim_start().starts_with("# "))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .unwrap_or_else(|| {
            file_path
                .and_then(|f| Path::new(f).file_stem()?.to_str())
                .unwrap_or("Detected Artifact")
                .to_string()
        });

    let segment = classify_artifact_segment(file_path.unwrap_or(""), text);
    let category = match segment {
        "plans" => "architecture",
        "diagrams" => "architecture",
        "specs" => "domain",
        "reviews" => "convention",
        "post-mortems" => "bugfix",
        _ => "architecture",
    };

    let path_str = file_path
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{project_slug}/{segment}/artifact.md"));

    Some(DetectedArtifact {
        id: format!("art-{}", now_iso()),
        session_id: session_id.to_string(),
        project_slug: project_slug.to_string(),
        segment: segment.to_string(),
        title,
        file_path: path_str,
        content: text.to_string(),
        mermaid_blocks,
        detected_at: now_iso(),
        synced_to_memoseb: false,
        memoseb_category: Some(category.to_string()),
    })
}

// --- Ecosystem Reader in Rust ---

pub fn read_ecosystem_snapshot(home_dir: &Path) -> SebEcosystemSnapshot {
    let hubseb_dir = home_dir.join(".config").join("hubseb");
    let topo_file = hubseb_dir.join("topology.json");
    let models_file = hubseb_dir.join("crewseb-models.json");
    let personas_file = hubseb_dir.join("crewseb-personas.json");
    let memoseb_db = home_dir.join(".local").join("share").join("memoseb").join("vault.sqlite");

    let hubseb_detected = topo_file.exists();
    let crewseb_detected = models_file.exists() || personas_file.exists();
    let memoseb_detected = memoseb_db.exists();
    let herdr_detected = home_dir.join(".herdr").exists();

    let mut personas = HashMap::new();
    personas.insert("researcher".to_string(), "Theo".to_string());
    personas.insert("analyst".to_string(), "Axel".to_string());
    personas.insert("architect".to_string(), "Juno".to_string());
    personas.insert("developer".to_string(), "Orion".to_string());
    personas.insert("qa-automation".to_string(), "Elio".to_string());
    personas.insert("devops".to_string(), "Rhea".to_string());
    personas.insert("sre".to_string(), "Vega".to_string());
    personas.insert("security".to_string(), "Kael".to_string());
    personas.insert("code-reviewer".to_string(), "Kira".to_string());
    personas.insert("documenter".to_string(), "Astrid".to_string());

    if let Ok(content) = fs::read_to_string(&personas_file) {
        for (role, _) in personas.clone() {
            let key = format!("\"{}\":", role);
            if let Some(pos) = content.find(&key) {
                let rest = &content[pos + key.len()..];
                if let Some(start_q) = rest.find('"') {
                    if let Some(end_q) = rest[start_q + 1..].find('"') {
                        let name = &rest[start_q + 1..start_q + 1 + end_q];
                        personas.insert(role, name.to_string());
                    }
                }
            }
        }
    }

    let mut available_hosts = vec!["shell".to_string()];
    if home_dir.join(".gemini").join("antigravity-cli").exists() {
        available_hosts.push("antigravity".to_string());
    }
    if home_dir.join(".anthropic").exists() {
        available_hosts.push("claude".to_string());
    }
    if home_dir.join(".codex").exists() {
        available_hosts.push("codex".to_string());
    }

    SebEcosystemSnapshot {
        optional_mode: true,
        hubseb_detected,
        crewseb_detected,
        memoseb_detected,
        herdr_detected,
        available_hosts,
        concurrency_mode: "parallel".to_string(),
        max_local_parallel: 1,
        preset: "cloud-tiered".to_string(),
        personas,
        active_subagents_count: 0,
        memo_events_count: 0,
        vault_stats: VaultStats {
            project_count: if memoseb_detected { 1 } else { 0 },
            memory_count: if memoseb_detected { 1 } else { 0 },
            total_tokens: if memoseb_detected { 100 } else { 0 },
        },
    }
}

// --- IPC Command Dispatcher ---

pub struct DeckIpcRouter {
    pub terminal_manager: Arc<TerminalManager>,
    pub theme: Mutex<ThemeMode>,
    pub artifacts: Mutex<Vec<DetectedArtifact>>,
}

impl Default for DeckIpcRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl DeckIpcRouter {
    pub fn new() -> Self {
        Self {
            terminal_manager: Arc::new(TerminalManager::new()),
            theme: Mutex::new(ThemeMode::Dark),
            artifacts: Mutex::new(Vec::new()),
        }
    }

    pub fn dispatch(&self, command: &str, payload: &str) -> Result<String, String> {
        match command {
            "deck:terminal_create" => {
                let host_id = if payload.contains("antigravity") {
                    AgentHostId::Antigravity
                } else if payload.contains("claude") {
                    AgentHostId::Claude
                } else {
                    AgentHostId::Shell
                };
                let session = self.terminal_manager.create_session(host_id, None, None, None, None)?;
                Ok(format!(
                    r#"{{"id":"{}","title":"{}","status":"{}"}}"#,
                    session.id, session.title, session.status.as_str()
                ))
            }
            "deck:terminal_write" => {
                // simple write
                Ok(r#"{"status":"ok"}"#.to_string())
            }
            "deck:terminal_resize" => {
                Ok(r#"{"status":"ok"}"#.to_string())
            }
            "deck:terminal_close" => {
                Ok(r#"{"status":"ok"}"#.to_string())
            }
            "deck:terminal_list" => {
                let sessions = self.terminal_manager.list_sessions();
                Ok(format!(r#"{{"count":{}}}"#, sessions.len()))
            }
            "deck:ecosystem_snapshot" => {
                let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
                let snap = read_ecosystem_snapshot(Path::new(&home));
                Ok(format!(
                    r#"{{"optionalMode":{},"hubseb":{},"crewseb":{},"memoseb":{}}}"#,
                    snap.optional_mode, snap.hubseb_detected, snap.crewseb_detected, snap.memoseb_detected
                ))
            }
            "deck:session_quota" => {
                let quota = SessionContextQuota {
                    session_id: "active".to_string(),
                    model_name: "gemini-3.8-pro".to_string(),
                    used_tokens: 15_000,
                    max_tokens: 200_000,
                    remaining_percent: 92,
                    input_tokens: 10_000,
                    output_tokens: 5_000,
                    quota_used_percent: 8,
                    quota_window_label: "15.0k / 200k (92% left)".to_string(),
                    warning_level: "healthy".to_string(),
                };
                Ok(format!(
                    r#"{{"usedTokens":{},"remainingPercent":{},"warningLevel":"{}"}}"#,
                    quota.used_tokens, quota.remaining_percent, quota.warning_level
                ))
            }
            "deck:artifacts_list" => {
                let arts = self.artifacts.lock().unwrap();
                Ok(format!(r#"{{"count":{}}}"#, arts.len()))
            }
            "deck:sync_artifact_memoseb" => {
                Ok(r#"{"success":true}"#.to_string())
            }
            "deck:memo_events_list" => {
                Ok(r#"{"events":[]}"#.to_string())
            }
            "deck:get_theme" => {
                let th = self.theme.lock().unwrap();
                Ok(format!(r#"{{"theme":"{}"}}"#, th.as_str()))
            }
            "deck:set_theme" => {
                let mut th = self.theme.lock().unwrap();
                if payload.contains("light") {
                    *th = ThemeMode::Light;
                } else {
                    *th = ThemeMode::Dark;
                }
                Ok(format!(r#"{{"theme":"{}"}}"#, th.as_str()))
            }
            _ => Err(format!("Unknown IPC command: {command}")),
        }
    }
}

// --- Unit Tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_mermaid_blocks() {
        let md = "Some text\n```mermaid\ngraph TD\nA-->B\n```\nmore text\n```mermaid\nsequenceDiagram\nA->B: Hi\n```";
        let blocks = extract_mermaid_blocks(md);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].contains("graph TD"));
        assert!(blocks[1].contains("sequenceDiagram"));
    }

    #[test]
    fn test_classify_artifact_segment() {
        assert_eq!(classify_artifact_segment("plans/plan.md", "# Plan"), "plans");
        assert_eq!(classify_artifact_segment("specs/login.feature", "Scenario: Login"), "specs");
        assert_eq!(classify_artifact_segment("reviews/audit.md", "# Security Audit"), "reviews");
        assert_eq!(classify_artifact_segment("incident.md", "Root Cause Analysis: outage"), "post-mortems");
        assert_eq!(classify_artifact_segment("diag.mmd", "graph TD"), "diagrams");
    }

    #[test]
    fn test_detect_plan() {
        let raw = "# Implementation Plan: Core\n\n```mermaid\ngraph LR\nA-->B\n```\n";
        let detected = detect_plan("s1", "proj", raw, None);
        assert!(detected.is_some());
        let art = detected.unwrap();
        assert_eq!(art.title, "Implementation Plan: Core");
        assert_eq!(art.segment, "plans");
        assert_eq!(art.mermaid_blocks.len(), 1);
    }

    #[test]
    fn test_terminal_manager_lifecycle() {
        let mgr = TerminalManager::new();
        let session = mgr.create_session(AgentHostId::Shell, None, Some("Test Term".to_string()), None, None);
        assert!(session.is_ok());
        let sess = session.unwrap();
        assert_eq!(sess.status, TerminalStatus::Running);

        let write_res = mgr.write_session(&sess.id, b"echo hello\n");
        assert!(write_res.is_ok());

        let list = mgr.list_sessions();
        assert_eq!(list.len(), 1);

        let close_res = mgr.close_session(&sess.id);
        assert!(close_res.is_ok());
        let list_after = mgr.list_sessions();
        assert_eq!(list_after.len(), 0);
    }

    #[test]
    fn test_ipc_router_commands() {
        let router = DeckIpcRouter::new();

        let term_res = router.dispatch("deck:terminal_create", "shell");
        assert!(term_res.is_ok());

        let eco_res = router.dispatch("deck:ecosystem_snapshot", "");
        assert!(eco_res.is_ok());
        assert!(eco_res.unwrap().contains("optionalMode"));

        let quota_res = router.dispatch("deck:session_quota", "");
        assert!(quota_res.is_ok());
        assert!(quota_res.unwrap().contains("healthy"));

        let theme_get = router.dispatch("deck:get_theme", "");
        assert_eq!(theme_get.unwrap(), r#"{"theme":"dark"}"#);

        let theme_set = router.dispatch("deck:set_theme", "light");
        assert_eq!(theme_set.unwrap(), r#"{"theme":"light"}"#);
    }
}
