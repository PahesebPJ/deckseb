use deckseb_lib::DeckIpcRouter;

fn main() {
    println!("deckseb-backend v0.2.1 starting (Tauri v2 minimal plan viewer)...");
    let router = DeckIpcRouter::new();
    println!("Router initialized with minimal IPC command handlers ready.");

    if let Ok(res) = router.dispatch("deck:artifacts_list", "") {
        println!("Artifacts status: {res}");
    }
}
