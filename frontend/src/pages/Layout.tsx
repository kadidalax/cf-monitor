import React, { useEffect, useState } from "react";
import { Outlet, Link, useNavigate } from "react-router-dom";
import { Text, IconButton } from "@radix-ui/themes";
import { Settings, Sun, Moon, Laptop, Palette, Github } from "lucide-react";

import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useDisplayTheme } from "../contexts/DisplayThemeContext";
import { CF_MONITOR_GITHUB_URL } from "../utils/projectLinks";
import { fetchPublicSettings } from "../utils/publicSettings";

export default function Layout() {
  const { isAuthenticated } = useAuth();
  const { theme, setTheme } = useTheme();
  const { displayTheme, toggleDisplayTheme } = useDisplayTheme();
  const navigate = useNavigate();
  const githubUrl = CF_MONITOR_GITHUB_URL;
  const [siteTitle, setSiteTitle] = useState("CF Monitor");
  const [siteSubtitle, setSiteSubtitle] = useState<string | null>(null);
  const [bgUrlDesktop, setBgUrlDesktop] = useState("");
  const [bgUrlMobile, setBgUrlMobile] = useState("");
  const [mainContentWidth, setMainContentWidth] = useState(100);

  useEffect(() => {
    fetchPublicSettings()
      .then((data) => {
        if (data.site_title) setSiteTitle(data.site_title);
        if (typeof data.site_subtitle === "string" && data.site_subtitle.trim()) {
          setSiteSubtitle(data.site_subtitle);
        }
        if (data.theme_settings?.backgroundImageUrlDesktop)
          setBgUrlDesktop(data.theme_settings.backgroundImageUrlDesktop);
        if (data.theme_settings?.backgroundImageUrlMobile)
          setBgUrlMobile(data.theme_settings.backgroundImageUrlMobile);
        if (data.theme_settings?.mainContentWidth)
          setMainContentWidth(data.theme_settings.mainContentWidth);
      })
      .catch(() => {});
  }, []);

  const cycleTheme = () => {
    const themes: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];
    const idx = themes.indexOf(theme);
    setTheme(themes[(idx + 1) % themes.length]);
  };

  const enterBackend = () => {
    navigate(isAuthenticated ? "/admin" : "/login");
  };

  const openGithub = () => {
    if (!githubUrl) return;
    window.open(githubUrl, "_blank", "noopener,noreferrer");
  };

  const themeIcon =
    theme === "dark" ? <Moon size={18} /> : theme === "light" ? <Sun size={18} /> : <Laptop size={18} />;
  const nextDisplayTheme = displayTheme === "monitor" ? "next" : "monitor";
  const nextThemeLabel =
    theme === "light" ? "切换成深色模式" : theme === "dark" ? "切换成跟随系统" : "切换成浅色模式";
  const bgUrl = bgUrlDesktop || bgUrlMobile;
  const contentWidth = mainContentWidth >= 100 ? "100%" : `${mainContentWidth}vw`;

  return (
    <div
      className={bgUrl ? "layout bg-cover bg-center bg-fixed bg-no-repeat" : "layout"}
      style={{ backgroundImage: bgUrl ? `url(${bgUrl})` : "none", backgroundColor: bgUrl ? "transparent" : "var(--accent-1)" }}
    >
      <main
        className="main-content h-full"
        style={{ width: contentWidth, maxWidth: "100%", marginLeft: "auto", marginRight: "auto" }}
      >
        <nav className="nav-bar">
          <div className="nav-brand">
            <Link to="/" className="nav-brand-link">
              <span className="nav-logo-mark" aria-hidden="true">C</span>
              <span className="nav-brand-title">{siteTitle}</span>
            </Link>
            {siteSubtitle && (
              <div className="nav-brand-subtitle">
                <div className="nav-brand-divider" />
                <span>{siteSubtitle}</span>
              </div>
            )}
          </div>

          <div className="nav-actions">
            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={openGithub}
              aria-label={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
              aria-disabled={!githubUrl}
              title={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
            >
              <Github size={18} />
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={toggleDisplayTheme}
              aria-label={`切换成 ${nextDisplayTheme} 主题`}
              title={`切换成 ${nextDisplayTheme} 主题`}
            >
              <Palette size={18} />
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={cycleTheme}
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
            >
              {themeIcon}
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={enterBackend}
              aria-label={isAuthenticated ? "进入后台" : "后台登录"}
              title={isAuthenticated ? "进入后台" : "后台登录"}
            >
              <Settings size={18} />
            </IconButton>
          </div>
        </nav>

        <Outlet />
      </main>

      <footer className="footer">
        <Text size="2" color="gray">Powered by CF Monitor.</Text>
      </footer>
    </div>
  );
}
