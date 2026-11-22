# Matrícula Chat (prototipo)

Avisa a otros conductores por su matrícula. **Sin servidores propios, sin registro y con cifrado de extremo a extremo.**

La app es un conjunto de archivos estáticos (`dist/`). Los mensajes viajan por **relays públicos de la red [Nostr](https://nostr.com)**, que mantienen terceros. No hay ninguna máquina tuya: puedes alojar `dist/` en GitHub Pages, IPFS, Netlify, o incluso abrirla desde un pendrive con cualquier servidor estático.

## Cómo funciona

| Pieza | Implementación |
|---|---|
| Identidad | Un par de claves generado en el dispositivo. Sin nombre, teléfono ni email. |
| Matrícula | Se publica como `scrypt(matrícula)`, nunca en claro. |
| Reclamar matrícula | Evento firmado `kind 7151` con etiqueta `x = hash` y prueba de trabajo (16 bits, NIP-13) para encarecer el spam. |
| Quién es el titular | Cada cliente descarga el historial público de reclamaciones y aplica las mismas reglas (`src/protocol.js`): **gana la última**. No hace falta ningún árbitro. |
| Expulsión | Si otro dispositivo reclama tu matrícula, el tuyo lo detecta, te avisa y deja de aceptar mensajes. |
| Anti ping-pong | 3 cambios de titular en 24 h → la matrícula queda **congelada 24 h** y nadie recibe mensajes. |
| Mensajes | `kind 7152`, cifrados con NIP-44 para la clave del titular, y con expiración de 72 h (NIP-40). |
| Remitente anónimo | Una clave efímera nueva para cada conversación. |
| Conversaciones atadas a la clave | Si cambia el titular, las conversaciones abiertas se cierran. El nuevo dispositivo no puede leer nada anterior ni continuar conversaciones ajenas. |
| Anti acoso | Un desconocido solo puede enviar **avisos predefinidos** hasta que el titular conteste. Lo aplica el cliente del receptor, así que modificar la app del remitente no sirve de nada. |

## App móvil (Android e iOS)

La app nativa es la misma app web empaquetada con [Capacitor](https://capacitorjs.com) (`android/` e `ios/`). Además usa notificaciones nativas.

**Android: compilar el APK**

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug   # → android/app/build/outputs/apk/debug/app-debug.apk
```

Necesitas JDK 21 y el Android SDK (plataforma 36) en `ANDROID_HOME`. El APK de depuración está firmado con la clave de depuración: sirve para instalarlo a mano, no para Google Play.

**iOS** (necesitas un Mac con Xcode)

```bash
npm install && npm run build && npx cap sync ios
npx cap open ios        # abre Xcode: elige tu equipo de firma y pulsa ▶
```

Para instalarla en un iPhone hace falta una cuenta de Apple (gratuita para probar en tu propio dispositivo; 99 €/año para TestFlight o la App Store).

## Desarrollo

```bash
npm install
npm run build        # genera dist/
npm test             # tests unitarios del protocolo
```

Probar en local, sin internet, con un relay de pruebas:

```bash
npm run relay                                   # ws://localhost:7777
(cd dist && python3 -m http.server 8080)
# abre http://localhost:8080/?relays=ws://localhost:7777 en dos navegadores o perfiles
node test/e2e.mjs                               # prueba con 3 dispositivos (Playwright)
```

Sin el parámetro `?relays=`, la app usa los relays públicos definidos en `DEFAULT_RELAYS` (`src/app.js`).

## Limitaciones conocidas (es un prototipo)

- **Las notificaciones solo llegan con la app abierta o recién minimizada.** Al poco de pasar a segundo plano, Android e iOS congelan la app. El push con la app cerrada exige pasar por Apple o Google, y en la práctica necesita un servidor que envíe el push. Es la principal concesión del modelo "sin servidor".
- **Metadatos públicos.** Cualquiera puede ver en los relays que el hash H tiene titular y que la clave K recibe mensajes a ciertas horas, aunque no pueda leer el contenido. Mejora posible: *gift wrap* (NIP-59).
- **Enumeración de matrículas.** scrypt encarece mucho recorrer los ~80 M de matrículas posibles, pero no lo impide. Alguien con mucha capacidad de cálculo podría saber qué matrículas están registradas.
- **No hay reloj de confianza.** Las fechas de los eventos las pone quien los firma. Se rechazan las fechas futuras, pero un atacante podría antedatar reclamaciones para provocar una disputa (congelar una matrícula), no para quedársela.
- **Spam de reclamaciones** desde muchas claves para congelar matrículas ajenas: la prueba de trabajo lo encarece, pero no lo impide.
- **Los relays son de terceros.** Pueden caerse, rechazar kinds poco comunes o no respetar la expiración. Conviene usar varios.
- **Las claves se guardan en `localStorage`.** Si borras los datos del navegador, pierdes la matrícula y tendrás que volver a reclamarla.
- **Un solo dispositivo por matrícula.** Aún no hay forma de vincular un segundo dispositivo por QR.
- **No probado contra relays públicos** desde el entorno de desarrollo (sin acceso de red). Solo se ha probado contra el relay local.

## Nota legal

Que no haya servidor no elimina las obligaciones del editor de la app (aviso legal LSSI, política de privacidad, términos y canal de denuncias DSA, evaluación de impacto RGPD). Consúltalo con un abogado antes de publicarla.
