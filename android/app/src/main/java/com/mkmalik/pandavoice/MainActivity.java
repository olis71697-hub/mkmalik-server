package com.mkmalik.pandavoice;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/** Native Android shell for the bundled Panda Voice app. */
public final class MainActivity extends Activity {
    private static final int REQUEST_MICROPHONE = 40;
    // Use a new path outside the old PWA service-worker scope (/assets/).
    private static final String APP_URL = "https://appassets.androidplatform.net/panda/index.html?v=1.0.3";

    private WebView webView;
    private PermissionRequest pendingMicRequest;
    private boolean startupCheckScheduled;
    private boolean startupErrorShown;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        styleSystemBars();

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/panda/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(255, 250, 241));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                return response != null ? response : super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    Log.e("PandaVoice", "main-frame load error: " + error.getDescription());
                    showStartupFailure();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (startupCheckScheduled || !url.startsWith("https://appassets.androidplatform.net/panda/index.html")) return;
                startupCheckScheduled = true;
                mainHandler.postDelayed(() -> {
                    if (webView == null || startupErrorShown) return;
                    webView.evaluateJavascript(
                            "(function(){var b=document.getElementById('boot');" +
                            "return !!document.querySelector('#offlineScreen') || " +
                            "!!document.querySelector('#authScreen:not([hidden])') || " +
                            "!!document.querySelector('#onboarding:not([hidden])') || " +
                            "!!document.querySelector('#app:not([hidden])') || " +
                            "!!(b && b.style.display==='none');})()",
                            result -> {
                                Log.i("PandaVoice", "startup-ready=" + result);
                                if (!"true".equals(result)) showStartupFailure();
                            });
                }, 25000);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("appassets.androidplatform.net".equals(uri.getHost())) return false;
                if ("https".equalsIgnoreCase(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                    return true;
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> grantMicrophoneWhenAllowed(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMicRequest == request) pendingMicRequest = null;
            }
        });

        setContentView(webView);
        webView.loadUrl(APP_URL);
    }

    private void showStartupFailure() {
        if (webView == null || startupErrorShown) return;
        startupErrorShown = true;
        String html = "<!doctype html><html lang='bn'><meta charset='utf-8'>" +
                "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
                "<body style='margin:0;background:#fffaf1;color:#24302a;font-family:sans-serif;" +
                "display:grid;min-height:100vh;place-items:center;text-align:center'>" +
                "<main style='padding:28px;max-width:360px'><div style='font-size:48px'>🐼</div>" +
                "<h2>Panda Voice চালু হচ্ছে না</h2>" +
                "<p>ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>" +
                "<button onclick=\"location.href='" + APP_URL + "'\" style='padding:12px 22px;" +
                "border:0;border-radius:12px;background:#b26100;color:white;font-size:16px'>" +
                "আবার চেষ্টা করুন</button></main></body></html>";
        webView.loadDataWithBaseURL(APP_URL, html, "text/html", "UTF-8", null);
    }

    private void grantMicrophoneWhenAllowed(PermissionRequest request) {
        String[] resources = request.getResources();
        boolean audioOnly = resources.length > 0;
        for (String resource : resources) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audioOnly = false;
        }
        if (!audioOnly) {
            request.deny();
            return;
        }

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }

        pendingMicRequest = request;
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_MICROPHONE || pendingMicRequest == null) return;

        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMicRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMicRequest.deny();
        }
        pendingMicRequest = null;
    }

    private void styleSystemBars() {
        getWindow().setStatusBarColor(Color.rgb(255, 250, 241));
        getWindow().setNavigationBarColor(Color.rgb(255, 250, 241));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
