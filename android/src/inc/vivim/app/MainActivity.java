package inc.vivim.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;

/**
 * VIVIM native shell: a full-screen WebView around the Studio mobile PWA.
 *
 * First launch shows a pairing screen (pairing URL persisted in SharedPreferences).
 * Later launches load the saved URL directly. Long-press on an empty part of the page
 * opens a small menu with Reload / Re-pair. A pairing URL can also be supplied by intent:
 *   adb shell am start -n inc.vivim.app/.MainActivity --es pairUrl "http://..."
 *   vivim://pair?pairUrl=http%3A%2F%2F...
 * Intent-supplied URLs are never loaded silently; the user confirms them on the pairing screen.
 *
 * Only the paired Studio origin (scheme + host + port) is browsed inside the shell, so the
 * pairing cookie and the error/expiry screens apply to the PC only; any other link opens in
 * the phone's normal browser.
 *
 * NOTE: listener classes are declared as static named nested classes on purpose.
 * build-tools 34.0.0's d8 (R8 8.2.2) crashes with an internal NPE when it has to
 * dex anonymous or non-static inner classes produced by recent javac, so this file
 * avoids both (and lambdas) and passes the activity reference explicitly.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "vivim";
    private static final String KEY_URL = "pair_url";
    private static final String EXTRA_PAIR_URL = "pairUrl";
    private static final int ERROR_RED = Color.rgb(161, 40, 48);
    private static final long CONNECT_WAIT_MS = 20000;

    private WebView web;
    private SharedPreferences prefs;
    /** True while the WebView (not the pairing screen) is the content view. */
    private boolean showingWeb;
    /** Last main-frame load of the paired origin failed; Back must not return to that error page. */
    private boolean loadFailed;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ConnectionWait connectionWait = new ConnectionWait(this);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Remote WebView debugging only on debuggable (developer) builds.
        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        web = createWebView();

        String incoming = incomingUrl(getIntent());
        String saved = savedUrl();
        if (incoming != null && !incoming.equals(saved)) {
            showPairScreen(incoming, confirmNotice(incoming), false);
        } else if (saved == null) {
            showPairScreen(null, null, false);
        } else {
            loadWorld(saved);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String incoming = incomingUrl(intent);
        if (incoming != null && (!incoming.equals(savedUrl()) || loadFailed || !showingWeb)) {
            showPairScreen(incoming, confirmNotice(incoming), false);
        }
    }

    // ---------------------------------------------------------------- WebView

    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // The mobile surface never opens pop-ups or autoplays media; keep both locked down.
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " VIVIM/1.0.0");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(view, false);

        view.setBackgroundColor(Color.WHITE);
        view.setWebViewClient(new ShellClient(this));
        view.setOnLongClickListener(new ShellLongPress(this));
        return view;
    }

    private void loadWorld(String url) {
        web.stopLoading();
        showingWeb = true;
        loadFailed = false;
        setContentView(web);
        startConnectionWait();
        web.loadUrl(url);
    }

    private void startConnectionWait() {
        handler.removeCallbacks(connectionWait);
        handler.postDelayed(connectionWait, CONNECT_WAIT_MS);
    }

    private void connectionFailed(String notice) {
        if (!showingWeb) {
            return;
        }
        loadFailed = true;
        showPairScreen(savedUrl(), notice, true);
    }

    private static final class ConnectionWait implements Runnable {
        private final MainActivity host;

        ConnectionWait(MainActivity host) {
            this.host = host;
        }

        @Override
        public void run() {
            host.connectionFailed("Your PC isn't responding yet. Check that VIVIM is open on your PC "
                    + "and both devices are on the same Wi-Fi, then tap Connect to try again. "
                    + "Your pairing link is still saved.");
        }
    }

    /** Back from the pairing screen returns to a working page instead of closing the app. */
    private void showWorldAgain() {
        if (web.getProgress() < 100) {
            loadWorld(savedUrl());
            return;
        }
        showingWeb = true;
        setContentView(web);
    }

    private boolean isPairedOrigin(Uri uri) {
        String saved = savedUrl();
        return saved != null && sameOrigin(uri, Uri.parse(saved));
    }

    /** Opens a link outside the shell. Only browsable handlers are eligible; intent: URIs are refused. */
    private void openExternally(Uri uri) {
        String scheme = uri == null ? null : uri.getScheme();
        if (scheme == null || "intent".equalsIgnoreCase(scheme) || "file".equalsIgnoreCase(scheme)
                || "content".equalsIgnoreCase(scheme) || "javascript".equalsIgnoreCase(scheme)) {
            return;
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, uri);
            view.addCategory(Intent.CATEGORY_BROWSABLE);
            view.setComponent(null);
            view.setSelector(null);
            startActivity(view);
        } catch (Exception ignored) {
            // no handler installed; keep the shell alive
        }
    }

    /** Keeps the paired Studio inside the shell and hands everything else to the system. */
    private static final class ShellClient extends WebViewClient {
        private final MainActivity host;

        ShellClient(MainActivity host) {
            this.host = host;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) {
                return false;
            }
            Uri uri = request.getUrl();
            if (uri != null && host.isPairedOrigin(uri)) {
                return false;
            }
            host.openExternally(uri);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (host.showingWeb) {
                host.loadFailed = false;
                host.startConnectionWait();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (host.showingWeb && !host.loadFailed && host.isPairedOrigin(Uri.parse(url))) {
                host.handler.removeCallbacks(host.connectionWait);
                // Persist the PC's pairing cookie now, not only when Android pauses the app.
                CookieManager.getInstance().flush();
            }
        }

        // Consumer-facing failure: the PC is off, Studio is stopped, or the phone left the WiFi.
        // Show the pairing screen with a plain explanation instead of a blank Chrome error page.
        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame() && host.isPairedOrigin(request.getUrl())) {
                host.connectionFailed("Can't reach VIVIM on your PC. Make sure VIVIM is open on the PC "
                        + "and this phone is on the same Wi-Fi. Then tap Connect to try again. "
                        + "If the PC's address changed, paste its new phone pairing link.");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request == null || !request.isForMainFrame() || response == null
                    || !host.isPairedOrigin(request.getUrl())) {
                return;
            }
            int code = response.getStatusCode();
            String notice = null;
            if (code == 401) {
                notice = "This pairing has expired (Studio was restarted with a new code). "
                        + "Scan or paste the new pairing URL from your PC.";
            } else if (code == 421 || code == 403) {
                notice = "Your PC no longer answers at this address (its WiFi address may have changed). "
                        + "Scan or paste the new pairing URL from your PC.";
            } else if (code >= 400) {
                notice = "VIVIM on your PC couldn't open this page. Check VIVIM on the PC, then tap "
                        + "Connect to try again. If this keeps happening, paste a new phone pairing link.";
            }
            if (notice != null) {
                host.connectionFailed(notice);
            }
        }

        // A crashed or OOM-killed renderer would otherwise take the whole app down.
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            host.recoverFromRendererLoss(view);
            return true;
        }
    }

    private void recoverFromRendererLoss(WebView dead) {
        if (dead != web) {
            return;
        }
        ViewGroup parent = (ViewGroup) dead.getParent();
        if (parent != null) {
            parent.removeView(dead);
        }
        dead.destroy();
        web = createWebView();
        String saved = savedUrl();
        if (saved != null && showingWeb) {
            connectionFailed("VIVIM needs to reopen this page. Tap Connect to continue with your saved PC. "
                    + "If you were writing a message, check it before sending.");
        } else if (saved == null) {
            showPairScreen(null, null, false);
        }
    }

    /** Long-press menu only on plain page areas, never over inputs (paste), links or images. */
    private static final class ShellLongPress implements View.OnLongClickListener {
        private final MainActivity host;

        ShellLongPress(MainActivity host) {
            this.host = host;
        }

        @Override
        public boolean onLongClick(View v) {
            WebView view = (WebView) v;
            WebView.HitTestResult hit = view.getHitTestResult();
            if (hit == null || hit.getType() == WebView.HitTestResult.UNKNOWN_TYPE) {
                host.showShellMenu();
            }
            return false; // let the page keep its own long-press behaviour
        }
    }

    // ----------------------------------------------------------- pairing screen

    private void showPairScreen(String currentUrl, String notice, boolean isError) {
        showingWeb = false;
        handler.removeCallbacks(connectionWait);
        web.stopLoading();
        int pad = dp(24);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("VIVIM");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTextColor(Color.BLACK);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("On your Windows PC, open 'VIVIM phone pairing' and find its phone pairing link. "
                + "Paste that link here, or scan the PC's QR code with your camera and copy the link. "
                + "Keep both devices on the same Wi-Fi, then tap Connect. Your PC is remembered next time.");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setTextColor(Color.DKGRAY);
        hint.setPadding(0, dp(10), 0, dp(18));
        root.addView(hint);

        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        field.setSingleLine(false);
        field.setHint("http://192.168.x.x:<port>/mobile?token=...");
        field.setText(currentUrl == null ? "" : currentUrl);
        field.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(field);

        TextView message = new TextView(this);
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        message.setPadding(0, dp(8), 0, dp(8));
        if (notice != null) {
            message.setText(notice);
            message.setTextColor(isError ? ERROR_RED : Color.DKGRAY);
        }
        root.addView(message);

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        connect.setOnClickListener(new ConnectClick(this, field, message));
        root.addView(connect);

        setContentView(root);
        field.requestFocus();
    }

    private static final class ConnectClick implements View.OnClickListener {
        private final MainActivity host;
        private final EditText field;
        private final TextView message;

        ConnectClick(MainActivity host, EditText field, TextView message) {
            this.host = host;
            this.field = field;
            this.message = message;
        }

        @Override
        public void onClick(View v) {
            String url = normalizePairUrl(field.getText().toString());
            if (url == null) {
                message.setTextColor(ERROR_RED);
                message.setText("That doesn't look like a pairing URL. It starts with http:// and "
                        + "contains your PC's address, for example http://192.168.1.20:38703/mobile?token=...");
                return;
            }
            host.savePairUrl(url);
            host.loadWorld(url);
        }
    }

    // ------------------------------------------------------------------ helpers

    private void showShellMenu() {
        final String[] items = {"Reload page", "Re-pair (enter a new URL)", "Close VIVIM", "Cancel"};
        new AlertDialog.Builder(this)
                .setTitle("VIVIM")
                .setItems(items, new MenuClick(this))
                .show();
    }

    private static final class MenuClick implements DialogInterface.OnClickListener {
        private final MainActivity host;

        MenuClick(MainActivity host) {
            this.host = host;
        }

        @Override
        public void onClick(DialogInterface dialog, int which) {
            if (which == 0 && host.web != null) {
                // Start from the saved pairing link, not a failed page or an expired history entry.
                host.loadWorld(host.savedUrl());
            } else if (which == 1) {
                host.showPairScreen(host.savedUrl(), null, false);
            } else if (which == 2) {
                host.finish();
            }
        }
    }

    private String savedUrl() {
        return normalizePairUrl(prefs.getString(KEY_URL, null));
    }

    private void savePairUrl(String url) {
        prefs.edit().putString(KEY_URL, url).apply();
    }

    private static String incomingUrl(Intent intent) {
        if (intent == null) {
            return null;
        }
        String extra = normalizePairUrl(intent.getStringExtra(EXTRA_PAIR_URL));
        if (extra != null) {
            return extra;
        }
        Uri data = intent.getData();
        if (data == null) {
            return null;
        }
        if ("vivim".equalsIgnoreCase(data.getScheme())) {
            try {
                return normalizePairUrl(data.getQueryParameter(EXTRA_PAIR_URL));
            } catch (UnsupportedOperationException opaque) {
                return null;
            }
        }
        return normalizePairUrl(data.toString());
    }

    /**
     * Returns the trimmed URL when it is an absolute http(s) URL with a host and no user-info
     * (user-info such as http://good.example@1.2.3.4/ is a classic way to disguise the real host),
     * otherwise null.
     */
    private static String normalizePairUrl(String value) {
        if (value == null) {
            return null;
        }
        String v = value.trim();
        if (v.isEmpty() || v.indexOf(' ') >= 0 || v.indexOf('\n') >= 0) {
            return null;
        }
        Uri uri = Uri.parse(v);
        if ("vivim".equalsIgnoreCase(uri.getScheme()) && "pair".equalsIgnoreCase(uri.getHost())) {
            // Accept the same app link when pasted that Android accepts through ACTION_VIEW.
            String nested = uri.getQueryParameter(EXTRA_PAIR_URL);
            if (nested == null || !(nested.startsWith("http://") || nested.startsWith("https://"))) {
                return null;
            }
            return normalizePairUrl(nested);
        }
        String scheme = uri.getScheme();
        String hostName = uri.getHost();
        if (scheme == null || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            return null;
        }
        if (hostName == null || hostName.isEmpty() || uri.getUserInfo() != null) {
            return null;
        }
        return v;
    }

    private static int portOf(Uri uri) {
        if (uri.getPort() != -1) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static boolean sameOrigin(Uri a, Uri b) {
        if (a == null || b == null || a.getScheme() == null || a.getHost() == null || b.getHost() == null) {
            return false;
        }
        return a.getScheme().equalsIgnoreCase(String.valueOf(b.getScheme()))
                && a.getHost().equalsIgnoreCase(b.getHost())
                && portOf(a) == portOf(b);
    }

    /** Home-network style address: private IPv4, CGNAT/Tailscale, mDNS .local or a bare PC name. */
    private static boolean looksLikeHomeNetwork(String hostName) {
        if (hostName == null) {
            return false;
        }
        String h = hostName.toLowerCase(Locale.ROOT);
        if (h.endsWith(".local") || h.indexOf('.') < 0) {
            return true;
        }
        String[] parts = h.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        int a;
        int b;
        try {
            a = Integer.parseInt(parts[0]);
            b = Integer.parseInt(parts[1]);
        } catch (NumberFormatException notIpv4) {
            return false;
        }
        return a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31)
                || (a == 100 && b >= 64 && b <= 127);
    }

    private static String confirmNotice(String url) {
        Uri uri = Uri.parse(url);
        String where = uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        String text = "Pairing link received for " + where + ". Check this is your own PC's address "
                + "(Studio prints it), then tap Connect.";
        if (!looksLikeHomeNetwork(uri.getHost())) {
            text += " Warning: this is not a home-network address. Only connect if you started it yourself.";
        }
        return text;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // --------------------------------------------------------------- lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web != null && showingWeb && web.canGoBack()) {
            web.goBack();
            return;
        }
        if (web != null && !showingWeb && !loadFailed && web.getUrl() != null && savedUrl() != null) {
            showWorldAgain();
            return;
        }
        if (showingWeb) {
            // A normal Back press makes recovery discoverable without a hidden long-press gesture.
            showShellMenu();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(connectionWait);
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) {
                parent.removeView(web);
            }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
