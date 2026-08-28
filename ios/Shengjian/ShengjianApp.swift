import SwiftUI

@main
struct ShengjianApp: App {
    @State private var pendingInvite: RoomInvite?
    @State private var linkError: String?

    var body: some Scene {
        WindowGroup {
            ContentView(invite: $pendingInvite, linkError: $linkError)
                .onOpenURL { url in
                    do { pendingInvite = try RoomInvite.parse(url.absoluteString); linkError = nil }
                    catch { linkError = error.localizedDescription }
                }
        }
    }
}

