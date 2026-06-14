# fium — reglas de marca

Contexto de marca para Claude Code. Aplica estos tokens en todo el código de UI (sitio de
marketing, onboarding, emails, landing). No inventes colores ni fuentes fuera de los definidos aquí.

## Qué es fium

App chilena para Shopify que conecta Uber Direct a la tienda: envíos de última milla en un clic.
Personalidad de marca: infraestructura confiable + velocidad. Tono limpio, técnico y directo —
nunca "app de delivery" colorida. Vivimos entre Shopify y Uber, así que nos vemos como plataforma,
no como repartidor.

## Color

Roles, no decoración. El índigo domina; la lima es una chispa que se usa con avaricia.

| Token | Hex | Uso |
|-------|-----|-----|
| `brand` (Índigo Fium) | `#4B2BE0` | Color primario: botones, links, acentos de marca |
| `brand-hover` | `#3A1FB5` | Estado hover/active del primario |
| `brand-tint` | `#EEEDFE` | Fondos suaves, badges, estados seleccionados |
| `ink` (Tinta) | `#241266` | Títulos, texto fuerte, logotipo |
| `accent` (Impulso lima) | `#C9F03C` | SOLO acento: highlights, detalle del logo, micro-destellos |
| `accent-hover` | `#B4DC2E` | Hover de elementos lima interactivos |
| `accent-tint` | `#F4FBDD` | Fondo lima muy tenue |
| `text` | `#1C1633` | Texto de cuerpo |
| `text-muted` (Acero) | `#6E6B85` | Texto secundario, captions |
| `text-on-dark` | `#EDEBFA` | Texto sobre fondos índigo/oscuros |
| `bg` (Niebla) | `#F6F5FB` | Fondo de página |
| `surface` | `#FFFFFF` | Tarjetas, paneles |
| `border` | `#E4E2F0` | Bordes y divisores |
| `success` | `#1D9E75` | Estado OK / envío entregado |
| `warning` | `#EF9F27` | Advertencias |
| `danger` | `#E24B4A` | Errores |
| `info` | `#378ADD` | Información neutra |

Reglas duras:
- La lima NUNCA va como fondo grande ni como texto sobre blanco (no pasa contraste). Texto sobre
  lima = `ink` (`#241266`), nunca negro ni blanco.
- Texto sobre `brand`/índigo = blanco o `text-on-dark`.
- No uses naranja ni rojo como acento de marca (es el territorio de Rappi/PedidosYa; nos confunden).

### CSS custom properties

```css
:root {
  --color-brand: #4B2BE0;
  --color-brand-hover: #3A1FB5;
  --color-brand-tint: #EEEDFE;
  --color-ink: #241266;
  --color-accent: #C9F03C;
  --color-accent-hover: #B4DC2E;
  --color-accent-tint: #F4FBDD;
  --color-text: #1C1633;
  --color-text-muted: #6E6B85;
  --color-text-on-dark: #EDEBFA;
  --color-bg: #F6F5FB;
  --color-surface: #FFFFFF;
  --color-border: #E4E2F0;
  --color-success: #1D9E75;
  --color-warning: #EF9F27;
  --color-danger: #E24B4A;
  --color-info: #378ADD;
}
```

### Tailwind (extend en tailwind.config)

```js
theme: {
  extend: {
    colors: {
      brand: { DEFAULT: '#4B2BE0', hover: '#3A1FB5', tint: '#EEEDFE' },
      ink: '#241266',
      accent: { DEFAULT: '#C9F03C', hover: '#B4DC2E', tint: '#F4FBDD' },
      muted: '#6E6B85',
      niebla: '#F6F5FB',
      borde: '#E4E2F0',
    },
    fontFamily: {
      display: ['Sora', 'sans-serif'],
      sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
    },
  },
}
```

## Tipografía

- `Sora` (600 / 700) → logotipo, títulos y números grandes (h1–h3).
- `Plus Jakarta Sans` (400 / 500) → interfaz, párrafos, labels. Fallback: `Inter`.
- Solo cuatro pesos: 400, 500, 600, 700. Nunca uses 800/900.
- Capitalización: sentence case siempre. Nunca Title Case ni MAYÚSCULAS.

Carga (head del sitio de marketing):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500&display=swap" rel="stylesheet">
```

Escala sugerida (rem, line-height 1.4 en títulos / 1.7 en cuerpo):

| Nivel | Tamaño | Fuente / peso |
|-------|--------|---------------|
| h1 | 2.5rem | Sora 700 |
| h2 | 1.875rem | Sora 600 |
| h3 | 1.375rem | Sora 600 |
| body | 1rem | Plus Jakarta Sans 400 |
| small | 0.8125rem | Plus Jakarta Sans 400 |

## Logo

Archivos en el repo (no los regeneres, úsalos):
- `fium-logo.svg` — lockup (ícono + nombre). Para fondos claros.
- `fium-icono.svg` — isotipo (cuadrado índigo). Favicon, ícono de la app, avatar.

Reglas:
- Área de respeto mínima alrededor del logo = la altura del ícono.
- En fondo oscuro, el wordmark va en blanco (`#FFFFFF`); el ícono mantiene su cuadrado índigo.
- No deformes, no rotes, no cambies los colores del logo, no le pongas sombras.
- Tamaño mínimo del isotipo: 24px.

## Contexto Shopify (importante)

- **App embebida en el admin de Shopify**: usa Polaris (el design system de Shopify) y respeta su
  look nativo — los merchants esperan que se sienta parte del admin. Aplica la marca fium SOLO en el
  logo, el onboarding, estados vacíos y como acento del CTA principal. No reestilices Polaris entero.
- **Sitio de marketing / landing / emails**: marca fium completa, Sora en titulares, lima usada con
  moderación.
- No uses los logos ni los colores de Uber o Shopify, ni des a entender que son socios oficiales.
  Frases permitidas: "se conecta con Uber Direct", "app para Shopify".