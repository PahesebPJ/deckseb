use deckseb_lib::DeckIpcRouter;

fn main() {
    println!("deckseb-backend v0.1.0 starting (Tauri v2 native core)...");
    let router = DeckIpcRouter::new();
    println!("Router initialized with 12 IPC command handlers ready.");

    // Simple test run of ecosystem snapshot
    if let Ok(snap) = router.dispatch("deck:ecosystem_snapshot", "") {
        println!("Ecosystem snapshot: {snap}");
    }
}
