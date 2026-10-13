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
import * as Sharing from 'expo-sharing';

const SERVER_KEY = 'tailchat-server';
const GREEN = '#008069';
const DARK = '#111b21';

// The web app saves files by clicking an <a download> that points at a blob:
// URL, which Android's WebView ignores. This catches those clicks, reads the
// blob in the page and hands it to the app, which opens the share sheet.
const DOWNLOAD_BRIDGE = `
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[download]');
    if (!a || a.href.indexOf('blob:') !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var name = a.getAttribute('download') || 'file';
    fetch(a.href).then(function (r) { return r.blob(); }).then(function (blob) {
      var reader = new FileReader();
      reader.onload = function () {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'download', name: name, mime: blob.type, data: String(reader.result).split(',')[1] || '',
        }));
      };
      reader.readAsDataURL(blob);
    });
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

  const onMessage = useCallback(async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg?.type !== 'download' || typeof msg.data !== 'string') return;
    try {
      const file = new File(Paths.cache, safeFileName(msg.name));
      file.create({ overwrite: true });
      file.write(msg.data, { encoding: 'base64' });
      await Sharing.shareAsync(file.uri, { mimeType: msg.mime || 'application/octet-stream', dialogTitle: msg.name });
    } catch {
      // the user closed the share sheet or the cache is full; nothing to clean up
    }
  }, []);

  // Pages on the Tailchat server open in the app; any other link opens in the browser.
  const onShouldStart = useCallback((req) => {
    if (req.url.startsWith(`${server}/`) || req.url === server || /^(blob|data|about):/.test(req.url)) return true;
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
      onMessage={onMessage}
      injectedJavaScriptBeforeContentLoaded={DOWNLOAD_BRIDGE}
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
          <ActivityIndicator size="large" color={GREEN} />
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
    screen = <View style={styles.loading}><ActivityIndicator size="large" color={GREEN} /></View>;
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
    backgroundColor: '#202c33',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { color: '#f15c6d', marginTop: 8 },
  button: { backgroundColor: GREEN, borderRadius: 24, paddingVertical: 12, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { alignItems: 'center', marginTop: 16, padding: 8 },
  linkText: { color: '#00a884', fontSize: 16 },
});
