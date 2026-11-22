// js/lib.js — the ONLY place third-party code enters Lens.
// React 18 + htm (JSX-free templates), loaded as ES modules from esm.sh.
import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';

export const html = htm.bind(React.createElement);
export const {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  useReducer,
  useContext,
  useId,
  useSyncExternalStore,
  createContext,
  memo,
  forwardRef,
  Fragment,
  Component,
} = React;
export { React, createRoot };
