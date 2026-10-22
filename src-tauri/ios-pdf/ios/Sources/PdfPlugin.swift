import Tauri
import UIKit
import WebKit

private let maxPdfBytes = 20 * 1024 * 1024

// Direct native lifecycle cancellation reaches Rust even if the renderer or
// a begin command is still queued. No document data crosses this function.
@_silgen_name("mycarlos_pdf_background")
private func invalidatePdfRequests()

private struct OpenDocument: Decodable {
    let generation: UInt64
    let epoch: UInt64
    let data: String
    let title: String
    let closeLabel: String
    let activity: Channel
}

private struct CancelDocument: Decodable {
    let generation: UInt64
}

private final class PdfWebView: WKWebView {
    var onActivity: (() -> Void)?

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        let moved = super.accessibilityScroll(direction)
        if moved { onActivity?() }
        return moved
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        // Keep accessible text selection/copy, without Share, lookup or opening
        // another app from a PDF's selection menu.
        let allowed = [#selector(copy(_:)), #selector(select(_:)), #selector(selectAll(_:))]
        return allowed.contains(action) && super.canPerformAction(action, withSender: sender)
    }
}

/// Observes real input without taking touches away from WebKit. There is no
/// timer or automatic keepalive while a document is open.
private final class ReaderActivity: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var onActivity: (() -> Void)?
    private func touched() {
        onActivity?()
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        touched(); state = .began
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        touched(); state = .changed
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .ended }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
}

/// This view has no Tauri scripts, message handlers, file URLs or vault access.
/// The app delegates rendering to WebKit without calling PDFKit or lopdf here.
/// WebKit controls its own PDF implementation; this is not the desktop helper sandbox.
private final class PdfReader: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webview: WKWebView?
    private var bytes: Data?
    private let closeLabel: String
    private let activity: Channel
    private var completed = false
    private var lastActivity: TimeInterval = -Double.infinity
    var onFinish: ((Bool) -> Void)?

    init(bytes: Data, title: String, closeLabel: String, activity: Channel) {
        self.bytes = bytes
        self.closeLabel = closeLabel
        self.activity = activity
        super.init(nibName: nil, bundle: nil)
        self.title = title
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: closeLabel, style: .done, target: self, action: #selector(closeReader))
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptEnabled = false
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = false
        }
        let reader = PdfWebView(frame: .zero, configuration: config)
        reader.navigationDelegate = self
        reader.uiDelegate = self
        reader.allowsLinkPreview = false
        reader.onActivity = { [weak self] in self?.recordActivity() }
        let touches = ReaderActivity(target: nil, action: nil)
        touches.cancelsTouchesInView = false
        touches.delaysTouchesBegan = false
        touches.delaysTouchesEnded = false
        touches.delegate = touches
        touches.onActivity = { [weak self] in self?.recordActivity() }
        reader.addGestureRecognizer(touches)
        reader.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(reader)
        NSLayoutConstraint.activate([
            reader.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            reader.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            reader.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            reader.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        webview = reader
        if var data = bytes {
            reader.load(data, mimeType: "application/pdf", characterEncodingName: "",
                        baseURL: URL(string: "about:blank")!)
            // WebKit has its own copy. Release the view controller's input copy.
            data.resetBytes(in: 0..<data.count)
            bytes = nil
        }
    }

    @objc private func closeReader() { finish(success: true) }

    private func recordActivity() {
        let now = ProcessInfo.processInfo.systemUptime
        guard !completed, now - lastActivity >= 1 else { return }
        lastActivity = now
        activity.send(["event": "activity"])
    }

    func finish(success: Bool) {
        guard !completed else { return }
        completed = true
        activity.send(["event": "closed"])
        if var data = bytes { data.resetBytes(in: 0..<data.count) }
        bytes = nil
        webview?.stopLoading()
        webview?.navigationDelegate = nil
        webview?.uiDelegate = nil
        webview?.removeFromSuperview()
        webview = nil
        let callback = onFinish
        onFinish = nil
        // No animation: a background/lock must not leave a readable transition.
        if let controller = navigationController, controller.presentingViewController != nil {
            controller.dismiss(animated: false) { callback?(success) }
        } else {
            callback?(success)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only the initial in-memory load. A tapped link, form, file, network
        // destination, download or new frame has no way out of this reader.
        let initial = action.navigationType == .other
            && action.request.url?.absoluteString == "about:blank"
            && action.targetFrame?.isMainFrame == true
        decisionHandler(initial ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let allowed = response.canShowMIMEType && response.response.mimeType == "application/pdf"
        decisionHandler(allowed ? .allow : .cancel)
        if !allowed { finish(success: false) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures)
        -> WKWebView? { nil }

    func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
                 completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(success: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) { finish(success: false) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(success: false) }
}

class PdfPlugin: Plugin {
    private var generation: UInt64 = 0
    private var epoch: UInt64 = 0
    private var reader: PdfReader?
    private var inactiveObserver: NSObjectProtocol?

    override init() {
        super.init()
        inactiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            self.epoch &+= 1
            invalidatePdfRequests()
            self.reader?.finish(success: true)
        }
    }

    deinit {
        if let observer = inactiveObserver { NotificationCenter.default.removeObserver(observer) }
    }

    @objc public func begin(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active
            else { invoke.reject("cancelled"); return }
            invoke.resolve(["epoch": self.epoch])
        }
    }

    @objc public func open(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(OpenDocument.self)
        DispatchQueue.main.async {
            guard args.generation > self.generation else { invoke.resolve(); return }
            self.generation = args.generation
            self.reader?.finish(success: true)
            guard UIApplication.shared.applicationState == .active,
                  args.epoch == self.epoch,
                  args.data.utf8.count <= ((maxPdfBytes + 2) / 3) * 4,
                  let data = Data(base64Encoded: args.data), data.count <= maxPdfBytes,
                  data.starts(with: [0x25, 0x50, 0x44, 0x46, 0x2d]),
                  let presenter = self.manager.viewController,
                  presenter.presentedViewController == nil
            else { invoke.reject("pdf_view_failed"); return }
            let reader = PdfReader(bytes: data, title: args.title, closeLabel: args.closeLabel,
                                   activity: args.activity)
            self.reader = reader
            reader.onFinish = { [weak self, weak reader] success in
                if let self = self, self.reader === reader { self.reader = nil }
                if success { invoke.resolve() } else { invoke.reject("pdf_view_failed") }
            }
            let controller = UINavigationController(rootViewController: reader)
            controller.modalPresentationStyle = .overFullScreen
            presenter.present(controller, animated: false)
        }
    }

    @objc public func close(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(CancelDocument.self)
        DispatchQueue.main.async {
            if args.generation >= self.generation {
                self.generation = args.generation
                self.reader?.finish(success: true)
            }
            invoke.resolve()
        }
    }
}

@_cdecl("init_plugin_ios_pdf")
func initPlugin() -> Plugin { PdfPlugin() }
