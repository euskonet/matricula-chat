# Matrícula Chat

Avisa a otros conductores por su matrícula: luces encendidas, un coche que bloquea la salida, una rueda pinchada… Sin registro y con cifrado de extremo a extremo.

**Web:** https://euskonet.github.io/matricula-chat/

- Sin cuentas: no se pide nombre, teléfono ni email.
- Mensajes cifrados de extremo a extremo sobre la red [Nostr](https://nostr.com).
- El primer contacto es siempre un aviso predefinido; la conversación libre empieza cuando el titular contesta.
- Pegatinas QR para el coche: quien las escanea puede avisarte desde el navegador, sin instalar nada.
- App para Android e iOS con [Capacitor](https://capacitorjs.com).

## Desarrollo

```bash
npm install
npm run build        # genera dist/
npm test
```

**Android**

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```

**iOS** (Mac con Xcode)

```bash
npx cap sync ios
npx cap open ios
```
