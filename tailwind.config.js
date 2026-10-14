/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      fontFamily: {
        sans: ['var(--font)'],
        mono: ['var(--mono)'],
      },
      colors: {
        // PipelineSync accents (src/index.css). `brand` is the fill orange,
        // `brand-2` the readable text orange; the ps-* names avoid clobbering
        // Tailwind's own blue/cyan/green scales.
        brand: {
          DEFAULT: 'rgb(var(--brand-rgb) / <alpha-value>)',
          2: 'rgb(var(--brand-2-rgb) / <alpha-value>)',
        },
        'ps-blue': 'rgb(var(--blue-rgb) / <alpha-value>)',
        'ps-cyan': 'rgb(var(--cyan-rgb) / <alpha-value>)',
        'ps-green': 'rgb(var(--green-rgb) / <alpha-value>)',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          border: 'hsl(var(--sidebar-border))',
        },
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: 'var(--radius-sm)',
        xl: '14px',
        '2xl': 'var(--radius)',
        '3xl': 'var(--radius-lg)',
      },
      boxShadow: {
        ps: 'var(--shadow)',
        glow: 'var(--shadow-glow)',
      },
      transitionTimingFunction: {
        ps: 'cubic-bezier(.22,1,.36,1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
