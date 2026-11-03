use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// --- Domain Models ---

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

#[derive(Debug, Clone, PartialEq, Eq)]
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

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
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
        || (lower_content.contains("given ")
            && lower_content.contains("when ")
            && lower_content.contains("then "))
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

// --- Minimal IPC Command Dispatcher ---

pub struct DeckIpcRouter {
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
            theme: Mutex::new(ThemeMode::Dark),
            artifacts: Mutex::new(Vec::new()),
        }
    }

    pub fn dispatch(&self, command: &str, payload: &str) -> Result<String, String> {
        match command {
            "deck:artifacts_list" => {
                let arts = self.artifacts.lock().unwrap();
                Ok(format!(r#"{{"count":{}}}"#, arts.len()))
            }
            "deck:plan_submit" => {
                let artifact = detect_plan("session-ipc", "deckseb", payload, None)
                    .unwrap_or_else(|| DetectedArtifact {
                        id: format!("art-{}", now_iso()),
                        session_id: "session-ipc".to_string(),
                        project_slug: "deckseb".to_string(),
                        segment: classify_artifact_segment("plans/plan.md", payload).to_string(),
                        title: "Plan".to_string(),
                        file_path: "plans/plan.md".to_string(),
                        content: payload.to_string(),
                        mermaid_blocks: extract_mermaid_blocks(payload),
                        detected_at: now_iso(),
                        synced_to_memoseb: false,
                        memoseb_category: Some("architecture".to_string()),
                    });

                let title = artifact.title.clone();
                let segment = artifact.segment.clone();
                let mut arts = self.artifacts.lock().unwrap();
                arts.push(artifact);
                Ok(format!(r#"{{"title":"{}","segment":"{}"}}"#, title, segment))
            }
            "deck:sync_artifact_memoseb" => {
                Ok(r#"{"success":true}"#.to_string())
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
        assert_eq!(
            classify_artifact_segment("specs/login.feature", "Scenario: Login"),
            "specs"
        );
        assert_eq!(
            classify_artifact_segment("reviews/audit.md", "# Security Audit"),
            "reviews"
        );
        assert_eq!(
            classify_artifact_segment("incident.md", "Root Cause Analysis: outage"),
            "post-mortems"
        );
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
    fn test_ipc_router_commands() {
        let router = DeckIpcRouter::new();

        // 1. Theme get and set
        let theme_get = router.dispatch("deck:get_theme", "");
        assert_eq!(theme_get.unwrap(), r#"{"theme":"dark"}"#);

        let theme_set = router.dispatch("deck:set_theme", "light");
        assert_eq!(theme_set.unwrap(), r#"{"theme":"light"}"#);

        // 2. Submit plan
        let plan_payload = "# Plan de Prueba\n\n```mermaid\ngraph TD\nA-->B\n```";
        let submit_res = router.dispatch("deck:plan_submit", plan_payload);
        assert!(submit_res.is_ok());
        let submit_json = submit_res.unwrap();
        assert!(submit_json.contains("Plan de Prueba"));
        assert!(submit_json.contains("plans"));

        // 3. Artifacts list
        let list_res = router.dispatch("deck:artifacts_list", "");
        assert!(list_res.is_ok());
        assert_eq!(list_res.unwrap(), r#"{"count":1}"#);

        // 4. Memoseb sync
        let sync_res = router.dispatch("deck:sync_artifact_memoseb", "");
        assert!(sync_res.is_ok());
        assert_eq!(sync_res.unwrap(), r#"{"success":true}"#);
    }
}
