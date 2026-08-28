import SwiftUI

struct ContentView: View {
    @Binding var invite: RoomInvite?
    @Binding var linkError: String?
    @State private var input = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                Image(systemName: "person.2.wave.2.fill")
                    .font(.system(size: 54)).foregroundStyle(.tint)
                Text(invite == nil ? "加入共听" : "邀请已识别")
                    .font(.title2.bold())
                Text(invite == nil ? "点开朋友发来的链接，或在下方粘贴。" : "房间 \(invite!.roomId.prefix(8))…")
                    .foregroundStyle(.secondary)
                TextField("共听链接或 MB1. 邀请", text: $input, axis: .vertical)
                    .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
                Button("解析并加入") {
                    do { invite = try RoomInvite.parse(input); linkError = nil }
                    catch { linkError = error.localizedDescription }
                }.buttonStyle(.borderedProminent).disabled(input.isEmpty)
                if let linkError { Text(linkError).foregroundStyle(.red).font(.footnote) }
                Spacer()
            }
            .padding(24)
            .navigationTitle("声笺")
        }
    }
}

