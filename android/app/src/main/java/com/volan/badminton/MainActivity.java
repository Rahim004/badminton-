package com.volan.badminton;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

/**
 * Оболочка «Волана»: WebView, который открывает файлы игры из assets по https://appassets.androidplatform.net/game/
 * (WebViewAssetLoader). Свой https-origin нужен, чтобы работали ES-модули, localStorage профиля и WebSocket/WebRTC
 * онлайн-режима (из file:// модули не грузятся).
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/game/index.html";
    private static final String SITE_HOST = "rahim004.github.io";

    private WebView web;
    private long lastBack = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // экран не гаснет во время матча
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/game/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFF17134A);
        setContentView(web);
        hideSystemUi();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                                  // localStorage: профиль, настройки
        s.setMediaPlaybackRequiresUserGesture(false);                  // звук после первого касания (игра сама делает unlock)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);  // только https/wss
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // По этой метке игра узнаёт, что запущена в приложении (скрывает «Скачать», не ставит service worker).
        s.setUserAgentString(s.getUserAgentString() + " VolanApp/" + BuildConfig.VERSION_NAME + " Android");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setHapticFeedbackEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openExternal(u);                                       // скачивания, GitHub и т.п. — в браузере
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Онлайн-режим использует только RTCDataChannel (PeerJS) — разрешений камеры/микрофона не нужно.
                request.deny();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("Volan", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(startUrl(getIntent()));
    }

    /** Ссылка-приглашение https://rahim004.github.io/badminton-/#room-XXXXX → тот же хэш в локальной игре. */
    private String startUrl(Intent intent) {
        try {
            Uri d = intent == null ? null : intent.getData();
            if (d != null && SITE_HOST.equals(d.getHost()) && d.getFragment() != null && d.getFragment().startsWith("room-")) {
                return START + "#" + d.getFragment();
            }
        } catch (Exception ignored) { }
        return START;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web != null && intent != null && intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /** «Назад»: в матче — пауза, в паузе — продолжить, во вложенном экране — шаг назад, в главном меню — двойное нажатие для выхода. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(function(){try{return !!(window.__volan&&window.__volan.back());}catch(e){return false;}})()", value -> {
            if ("true".equals(value)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) { finish(); return; }
            lastBack = now;
            Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();     // игра сама ставит паузу по visibilitychange
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
