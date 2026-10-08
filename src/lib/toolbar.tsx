import { createContext, useContext } from "react";

/** The window toolbar (the strip next to the traffic lights). Pages portal their title and actions into it. */
export const ToolbarContext = createContext<HTMLElement | null>(null);
export const useToolbar = () => useContext(ToolbarContext);
