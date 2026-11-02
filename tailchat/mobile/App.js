import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { EncodingType, deleteAsync, readAsStringAsync } from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import TailchatCalls from './modules/tailchat-calls';

const SERVER_KEY = 'tailchat-server';
const ACCENT = '#3f5db3';
const DARK = '#1f1e1e';

// How much of a file crosses between the app and the page at a time, as
// base64. Small enough to keep memory flat, big enough to stay quick.
const CHUNK = 1024 * 1024;

// Runs in the page before Tailchat loads.
//
// Picking files: Tailchat asks for "any file" picks through
// window.TailchatApp.pickFiles, which opens Android's own document picker
// here in the app (expo-document-picker) instead of the WebView's file input.
// The app copies the picked files to its cache, and the page reads them back
// a chunk at a time and rebuilds them as Files.
//
// Saving files: the web app saves by clicking an <a download> that points at
// a blob: URL, which Android's WebView ignores. This catches those clicks and
// streams the blob to the app a chunk at a time; the app writes it to its
// cache and opens the share sheet. The page can't fetch blob: URLs (Tailchat's
// content policy), so the bridge remembers the blob behind each one.
//
// WebView also refuses navigator.clipboard.writeText, so copies go to the app.
//
// Calls and notifications: window.TailchatApp.post hands the page's messages
// to the app's Android side (modules/tailchat-calls), which rings, pops calls
// up over other apps and the lock screen, keeps a call going in the
// background, and shows message notifications. Its answers reach the page as
// 'tailchat-native' events. Without the native part (Expo Go) there's no
// post, and the page works as it does in a browser.
const PAGE_BRIDGE = `
(function () {
  var CHUNK = ${CHUNK};
  var calls = {};
  var seq = 0;
  function post(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  // Sends a request to the app; it answers through window.__tailchatApp.reply.
  function ask(msg) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      calls[id] = { resolve: resolve, reject: reject };
      msg.id = id;
      post(msg);
    });
  }
  function fromBase64(text) {
    var bin = atob(text);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }
  Object.defineProperty(window, '__tailchatApp', {
    value: Object.freeze({
      reply: function (id, value, error) {
        var call = calls[id];
        if (!call) return;
        delete calls[id];
        if (error) call.reject(new Error(error));
        else call.resolve(value);
      },
    }),
  });

  function readPicked(pick, index, info) {
    var parts = [];
    var offset = 0;
    function next() {
      if (info.size != null && offset >= info.size) return finish();
      return ask({ type: 'read', pick: pick, file: index, offset: offset }).then(function (data) {
        var bytes = fromBase64(data || '');
        if (bytes.length) parts.push(bytes);
        offset += bytes.length;
        // Size unknown: read until a short chunk. Known: stop at the size.
        if (info.size == null && bytes.length < CHUNK) return finish();
        if (info.size != null && !bytes.length && offset < info.size) throw new Error("Couldn't read " + info.name);
        return next();
      });
    }
    function finish() {
      return new File(parts, info.name || 'file', { type: info.mime || '', lastModified: info.lastModified || Date.now() });
    }
    return next();
  }

  window.TailchatApp = Object.freeze({
    platform: 'android',
    version: 4,
    ${TailchatCalls ? "post: function (msg) { post({ type: 'native', msg: msg }); }," : ''}
    pickFiles: function (options) {
      options = options || {};
      return ask({ type: 'pick', multiple: !!options.multiple }).then(function (picked) {
        if (!picked || !picked.files || !picked.files.length) return [];
        var total = picked.files.reduce(function (n, f) { return n + (f.size || 0); }, 0);
        if (total > 4 * CHUNK && typeof options.onLoading === 'function') options.onLoading();
        var files = [];
        var chain = Promise.resolve();
        picked.files.forEach(function (info, i) {
          chain = chain.then(function () {
            return readPicked(picked.pick, i, info).then(function (f) { files.push(f); });
          });
        });
        function release() { post({ type: 'picked', pick: picked.pick }); }
        return chain.then(function () { release(); return files; }, function (err) { release(); throw err; });
      });
    },
  });

  if (navigator.clipboard) {
    navigator.clipboard.writeText = function (text) {
      post({ type: 'copy', text: String(text) });
      return Promise.resolve();
    };
  }

  var saves = 0;
  function save(blob, name) {
    var offset = 0;
    var saveId = ++saves;
    var mime = blob.type || 'application/octet-stream';
    function next() {
      var end = Math.min(offset + CHUNK, blob.size);
      return toBase64(blob.slice(offset, end)).then(function (data) {
        var first = offset === 0;
        offset = end;
        return ask({ type: 'save', save: saveId, name: name, mime: mime, data: data, first: first, last: offset >= blob.size });
      }).then(function () {
        if (offset < blob.size) return next();
      });
    }
    return next();
  }
  // Tailchat's content policy (connect-src 'self') stops the page from
  // fetching blob: URLs, so keep each blob behind its URL and read it directly.
  var blobs = new Map();
  var createObjectURL = URL.createObjectURL;
  var revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var url = createObjectURL.call(URL, obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return revokeObjectURL.call(URL, url);
  };
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[download]');
    if (!a || a.href.indexOf('blob:') !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var blob = blobs.get(a.href);
    if (!blob) return;
    save(blob, a.getAttribute('download') || 'file').catch(function () {});
  }, true);
})();
true;
`;

// Accepts "tailchat.example.ts.net" or a full https:// URL and returns its origin.
function normalizeServer(input) {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeFileName(name) {
  return String(name).replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

// The page is reloading or closing: the Android side holds its messages
// until the next one says hello.
function pageGone() {
  try {
    TailchatCalls?.post(JSON.stringify({ type: 'page-gone' }));
  } catch {
    // nothing to tell
  }
}

function ServerForm({ initial, onSave }) {
  const [value, setValue] = useState(initial || '');
  const [error, setError] = useState('');

  const submit = () => {
    const origin = normalizeServer(value);
    if (!origin) {
      setError('Enter your server address, like https://tailchat.your-tailnet.ts.net');
      return;
    }
    onSave(origin);
  };

  return (
    <KeyboardAvoidingView style={styles.form} behavior="padding">
      <Text style={styles.title}>Tailchat</Text>
      <Text style={styles.body}>
        Connect Tailscale on this phone, then enter the address of your Tailchat server.
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(t) => { setValue(t); setError(''); }}
        onSubmitEditing={submit}
        placeholder="https://tailchat.your-tailnet.ts.net"
        placeholderTextColor="#8696a0"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

function LoadError({ server, onRetry, onChange }) {
  return (
    <View style={styles.form}>
      <Text style={styles.title}>Can't reach Tailchat</Text>
      <Text style={styles.body}>
        Couldn't open {server}. Check that Tailscale is connected on this phone and the server is running.
      </Text>
      <Pressable style={styles.button} onPress={onRetry}>
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
      <Pressable style={styles.link} onPress={onChange}>
        <Text style={styles.linkText}>Change server</Text>
      </Pressable>
    </View>
  );
}

function Chat({ server, onChangeServer }) {
  const web = useRef(null);
  const canGoBack = useRef(false);
  const picking = useRef(false);
  const pickCount = useRef(0);
  const picks = useRef(new Map()); // pick id -> cached copies of the picked files
  const saves = useRef(new Map()); // save id -> file being written
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current && web.current) {
        web.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  // What the Android side has to say goes to the page as a DOM event.
  useEffect(() => {
    if (!TailchatCalls) return undefined;
    const sub = TailchatCalls.addListener('message', (e) => {
      if (typeof e?.json !== 'string') return;
      web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('tailchat-native', { detail: JSON.parse(${JSON.stringify(e.json)}) })); true;`);
    });
    return () => {
      sub.remove();
      pageGone();
    };
  }, []);

  // Answers a request from the page bridge (see PAGE_BRIDGE).
  const reply = useCallback((id, value, error) => {
    const args = [id, value === undefined ? null : value, error || null].map((v) => JSON.stringify(v)).join(',');
    web.current?.injectJavaScript(`window.__tailchatApp && window.__tailchatApp.reply(${args}); true;`);
  }, []);

  const onMessage = useCallback(async (event) => {
    // Only Tailchat's own pages may use the bridge.
    try {
      if (new URL(event.nativeEvent.url).hostname.toLowerCase() !== new URL(server).hostname.toLowerCase()) return;
    } catch {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg?.type === 'copy' && typeof msg.text === 'string') {
      Clipboard.setStringAsync(msg.text).catch(() => {});
      return;
    }
    if (msg?.type === 'native' && msg.msg && typeof msg.msg === 'object') {
      try {
        TailchatCalls?.post(JSON.stringify(msg.msg));
      } catch {
        // the native side refused it
      }
      return;
    }
    if (!Number.isSafeInteger(msg?.id)) return;
    const { id } = msg;

    if (msg.type === 'pick') {
      if (picking.current) return reply(id, null);
      picking.current = true;
      try {
        const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: !!msg.multiple, copyToCacheDirectory: true });
        if (result.canceled || !result.assets?.length) return reply(id, null);
        const pick = String(++pickCount.current);
        picks.current.set(pick, result.assets.map((a) => a.uri));
        reply(id, {
          pick,
          files: result.assets.map((a) => ({
            name: a.name || 'file',
            mime: a.mimeType || '',
            size: Number.isFinite(a.size) ? a.size : null,
            lastModified: a.lastModified || Date.now(),
          })),
        });
      } catch (err) {
        reply(id, null, `Couldn't open the file picker: ${err?.message || err}`);
      } finally {
        picking.current = false;
      }
      return;
    }

    if (msg.type === 'read') {
      const uri = picks.current.get(String(msg.pick))?.[msg.file];
      const offset = Number(msg.offset);
      if (!uri || !Number.isSafeInteger(offset) || offset < 0) return reply(id, null, 'That file is no longer available');
      try {
        const data = await readAsStringAsync(uri, { encoding: EncodingType.Base64, position: offset, length: CHUNK });
        reply(id, data);
      } catch (err) {
        reply(id, null, `Couldn't read the file: ${err?.message || err}`);
      }
      return;
    }

    if (msg.type === 'picked') {
      for (const uri of picks.current.get(String(msg.pick)) || []) deleteAsync(uri, { idempotent: true }).catch(() => {});
      picks.current.delete(String(msg.pick));
      return;
    }

    if (msg.type === 'save' && typeof msg.data === 'string') {
      try {
        const key = String(msg.save);
        let file = saves.current.get(key);
        if (msg.first || !file) {
          file = new File(Paths.cache, safeFileName(msg.name));
          file.create({ overwrite: true });
          saves.current.set(key, file);
        }
        file.write(msg.data, { encoding: 'base64', append: !msg.first });
        reply(id, true);
        if (msg.last) {
          saves.current.delete(key);
          await Sharing.shareAsync(file.uri, { mimeType: msg.mime || 'application/octet-stream', dialogTitle: msg.name });
        }
      } catch (err) {
        saves.current.delete(String(msg.save));
        reply(id, null, String(err?.message || err));
      }
    }
  }, [reply, server]);

  // Pages on the Tailchat machine open in the app; any other link opens in
  // the browser.
  const onShouldStart = useCallback((req) => {
    if (/^(blob|data|about):/.test(req.url)) return true;
    try {
      const url = new URL(req.url);
      if (url.protocol === 'https:' && url.hostname.toLowerCase() === new URL(server).hostname.toLowerCase()) return true;
    } catch {
      // not a URL we can open in the app
    }
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, [server]);

  if (failed) {
    return (
      <LoadError
        server={server}
        onRetry={() => { setFailed(false); setAttempt((n) => n + 1); }}
        onChange={onChangeServer}
      />
    );
  }

  return (
    <WebView
      key={attempt}
      ref={web}
      source={{ uri: `${server}/` }}
      style={styles.web}
      originWhitelist={['https://*', 'blob:*', 'data:*', 'about:*']}
      onShouldStartLoadWithRequest={onShouldStart}
      onNavigationStateChange={(s) => { canGoBack.current = s.canGoBack; }}
      onError={() => setFailed(true)}
      onLoadStart={pageGone}
      onMessage={onMessage}
      injectedJavaScriptBeforeContentLoaded={PAGE_BRIDGE}
      javaScriptEnabled
      domStorageEnabled
      geolocationEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="prompt"
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      pullToRefreshEnabled={false}
      startInLoadingState
      renderLoading={() => (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      )}
    />
  );
}

export default function App() {
  const [server, setServer] = useState(undefined);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SERVER_KEY)
      .then((s) => setServer(s || null))
      .catch(() => setServer(null));
  }, []);

  const save = (origin) => {
    AsyncStorage.setItem(SERVER_KEY, origin).catch(() => {});
    setServer(origin);
    setEditing(false);
  };

  let screen;
  if (server === undefined) {
    screen = <View style={styles.loading}><ActivityIndicator size="large" color={ACCENT} /></View>;
  } else if (!server || editing) {
    screen = <ServerForm initial={server} onSave={save} />;
  } else {
    screen = <Chat server={server} onChangeServer={() => setEditing(true)} />;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="light" backgroundColor={DARK} />
        {screen}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK },
  web: { flex: 1, backgroundColor: DARK },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: DARK },
  form: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: DARK },
  title: { color: '#e9edef', fontSize: 28, fontWeight: '600', marginBottom: 12 },
  body: { color: '#8696a0', fontSize: 16, lineHeight: 22, marginBottom: 24 },
  input: {
    color: '#e9edef',
    backgroundColor: '#2e2d2d',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { color: '#f15c6d', marginTop: 8 },
  button: { backgroundColor: ACCENT, borderRadius: 24, paddingVertical: 12, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { alignItems: 'center', marginTop: 16, padding: 8 },
  linkText: { color: '#8ea2e6', fontSize: 16 },
});
