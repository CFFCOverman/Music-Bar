import Foundation

struct RoomInvite: Equatable {
    let raw: String
    let endpoints: [URL]
    let roomId: String
    let token: Data

    static func parse(_ value: String) throws -> RoomInvite {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let invite: String
        if trimmed.hasPrefix("MB1.") {
            invite = trimmed
        } else if let url = URL(string: trimmed),
                  (url.scheme == "shengjian" && url.host == "join") ||
                    (["http", "https"].contains(url.scheme) && url.path == "/join"),
                  let fragment = url.fragment?.removingPercentEncoding,
                  fragment.hasPrefix("MB1.") {
            invite = fragment
        } else {
            throw InviteError.invalidLink
        }
        guard invite.count <= 4096,
              let data = Data(base64URL: String(invite.dropFirst(4))),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object.keys.sorted() == ["endpoints", "roomId", "token", "v"],
              object["v"] as? Int == 1,
              let endpointStrings = object["endpoints"] as? [String],
              (1...8).contains(endpointStrings.count),
              let roomId = object["roomId"] as? String,
              (16...64).contains(roomId.count),
              let tokenText = object["token"] as? String,
              let token = Data(base64URL: tokenText), token.count == 32 else {
            throw InviteError.invalidInvite
        }
        let endpoints = try endpointStrings.map { text -> URL in
            guard let url = URL(string: text), ["ws", "wss"].contains(url.scheme),
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.path == "/room/\(roomId)" else { throw InviteError.invalidEndpoint }
            return url
        }
        return RoomInvite(raw: invite, endpoints: endpoints, roomId: roomId, token: token)
    }
}

enum InviteError: LocalizedError {
    case invalidLink, invalidInvite, invalidEndpoint
    var errorDescription: String? {
        switch self {
        case .invalidLink: return "请粘贴有效的共听链接"
        case .invalidInvite: return "邀请内容无效"
        case .invalidEndpoint: return "房间地址无效"
        }
    }
}

private extension Data {
    init?(base64URL value: String) {
        guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}

