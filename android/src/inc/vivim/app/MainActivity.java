package inc.vivim.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * VIVIM native shell: a full-screen WebView around the Studio mobile PWA.
 *
 * First launch shows a pairing screen (pairing URL persisted in SharedPreferences).
 * Later launches load the saved URL directly. Long-press inside the page opens a
 * small menu with Reload / Re-pair. A pairing URL can also be supplied by intent:
 *   adb shell am start -n inc.vivim.app/.MainActivity --es pairUrl "http://..."
 *   vivim://pair?pairUrl=http%3A%2F%2F...
 *
 * NOTE: listener classes are declared as static named nested classes on purpose.
 * build-tools 34.0.0's d8 (R8 8.2.2) crashes with an internal NPE when it has to
 * dex anonymous or non-static inner classes produced by recent javac, so this file
 * avoids both and passes the activity reference explicitly.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "vivim";
    private static final String KEY_URL = "pair_url";
    private static final String EXTRA_PAIR_URL = "pairUrl";

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Remote WebView debugging only on debuggable (developer) builds.
        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        CookieManager.getInstance().setAcceptCookie(true);

        web = new WebView(this);
        configureWebView(web);

        // A pairing URL arriving by intent (adb, vivim://pair link) is never trusted silently:
        // any app or web page can fire it, so the user always confirms it on the pairing screen.
        String incoming = incomingUrl(getIntent());
        String saved = prefs.getString(KEY_URL, null);
        if (incoming != null && !incoming.equals(saved)) {
            showPairScreen(incoming, "Pairing link received. Check it is your own PC's address, then tap Connect.");
        } else if (saved == null || saved.trim().isEmpty()) {
            showPairScreen(null, null);
        } else {
            loadWorld(saved);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String incoming = incomingUrl(intent);
        if (incoming != null && !incoming.equals(prefs.getString(KEY_URL, null))) {
            showPairScreen(incoming, "Pairing link received. Check it is your own PC's address, then tap Connect.");
        }
    }

    // ---------------------------------------------------------------- WebView

    private void configureWebView(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " VIVIM/1.0.0");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(view, false);

        view.setBackgroundColor(Color.WHITE);
        view.setWebViewClient(new ShellClient(this));
        view.setOnLongClickListener(new ShellLongPress(this));
    }

    private void loadWorld(String url) {
        setContentView(web);
        web.loadUrl(url);
    }

    /** Keeps http(s) navigation inside the shell and hands everything else to the system. */
    private static final class ShellClient extends WebViewClient {
        private final MainActivity host;

        ShellClient(MainActivity host) {
            this.host = host;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri == null ? "" : String.valueOf(uri.getScheme());
            if ("http".equals(scheme) || "https".equals(scheme)) {
                return false;
            }
            try {
                host.startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // no handler installed; keep the shell alive
            }
            return true;
        }

        // Consumer-facing failure: the PC is off, Studio is stopped, or the phone left the WiFi.
        // Show the pairing screen with a plain explanation instead of a blank Chrome error page.
        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                host.showPairScreen(host.prefs.getString(KEY_URL, null),
                        "Can't reach VIVIM on your PC. Make sure the PC is on, Studio is running "
                                + "with LAN pairing, and this phone is on the same WiFi. Then tap Connect.");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
            if (request != null && request.isForMainFrame() && response != null && response.getStatusCode() == 401) {
                host.showPairScreen(host.prefs.getString(KEY_URL, null),
                        "This pairing has expired (Studio was restarted with a new code). "
                                + "Paste the new pairing URL from your PC.");
            }
        }
    }

    private static final class ShellLongPress implements View.OnLongClickListener {
        private final MainActivity host;

        ShellLongPress(MainActivity host) {
            this.host = host;
        }

        @Override
        public boolean onLongClick(View v) {
            host.showShellMenu();
            return false; // let the page keep its own long-press behaviour
        }
    }

    // ----------------------------------------------------------- pairing screen

    private void showPairScreen(String currentUrl, String notice) {
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
        hint.setText("Paste the pairing URL shown by Studio (LAN pair mode), then tap Connect. "
                + "The URL is remembered, so this screen only appears once.");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setTextColor(Color.DKGRAY);
        hint.setPadding(0, dp(10), 0, dp(18));
        root.addView(hint);

        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setSingleLine(false);
        field.setHint("http://<studio-host>:38710/mobile?token=...");
        field.setText(currentUrl == null ? "" : currentUrl);
        field.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(field);

        TextView error = new TextView(this);
        error.setTextColor(Color.rgb(161, 40, 48));
        error.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        error.setPadding(0, dp(8), 0, 0);
        if (notice != null) {
            error.setText(notice);
            error.setTextColor(Color.DKGRAY);
        }
        root.addView(error);

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        connect.setOnClickListener(new ConnectClick(this, field, error));
        root.addView(connect);

        setContentView(root);
        field.requestFocus();
    }

    private static final class ConnectClick implements View.OnClickListener {
        private final MainActivity host;
        private final EditText field;
        private final TextView error;

        ConnectClick(MainActivity host, EditText field, TextView error) {
            this.host = host;
            this.field = field;
            this.error = error;
        }

        @Override
        public void onClick(View v) {
            String url = field.getText().toString().trim();
            if (!isHttpUrl(url)) {
                error.setTextColor(Color.rgb(161, 40, 48));
                error.setText("Enter a full http:// or https:// URL.");
                return;
            }
            host.savePairUrl(url);
            host.loadWorld(url);
        }
    }

    // ------------------------------------------------------------------ helpers

    private void showShellMenu() {
        final String[] items = {"Reload page", "Re-pair (enter a new URL)", "Cancel"};
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
                host.web.reload();
            } else if (which == 1) {
                host.showPairScreen(host.prefs.getString(KEY_URL, null), null);
            }
        }
    }

    private void savePairUrl(String url) {
        prefs.edit().putString(KEY_URL, url.trim()).apply();
    }

    private String incomingUrl(Intent intent) {
        if (intent == null) {
            return null;
        }
        String extra = intent.getStringExtra(EXTRA_PAIR_URL);
        if (isHttpUrl(extra)) {
            return extra.trim();
        }
        Uri data = intent.getData();
        if (data != null) {
            String param = data.getQueryParameter(EXTRA_PAIR_URL);
            if (isHttpUrl(param)) {
                return param.trim();
            }
            if (isHttpUrl(data.toString())) {
                return data.toString().trim();
            }
        }
        return null;
    }

    private static boolean isHttpUrl(String value) {
        if (value == null) {
            return false;
        }
        String v = value.trim().toLowerCase();
        return v.startsWith("http://") || v.startsWith("https://");
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
        if (web != null && web.getParent() != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
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
