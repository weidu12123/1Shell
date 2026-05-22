package fileops

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type DirItem struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	MTime    int64  `json:"mtime"`
	IsHidden bool   `json:"isHidden,omitempty"`
}

type DirList struct {
	Path      string    `json:"path"`
	Parent    string    `json:"parent"`
	Items     []DirItem `json:"items"`
	IsRoot    bool      `json:"isRoot"`
	ItemTotal int       `json:"itemTotal"`
	Page      int       `json:"page,omitempty"`
	PageSize  int       `json:"pageSize,omitempty"`
}

type ListDirOptions struct {
	Path       string `json:"path"`
	Page       int    `json:"page"`
	PageSize   int    `json:"pageSize"`
	SortBy     string `json:"sortBy"`
	SortOrder  string `json:"sortOrder"`
	ShowHidden *bool  `json:"showHidden"`
}

func ListDir(opt ListDirOptions) (DirList, error) {
	target := strings.TrimSpace(opt.Path)
	if target == "" {
		target = "/"
	}
	if !filepath.IsAbs(target) {
		abs, err := filepath.Abs(target)
		if err != nil {
			return DirList{}, err
		}
		target = abs
	}
	target = filepath.Clean(target)
	if isProtectedPath(target) {
		return DirList{}, errors.New("访问被拒绝：该路径为 agent 敏感路径")
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return DirList{}, err
	}

	showHidden := true
	if opt.ShowHidden != nil {
		showHidden = *opt.ShowHidden
	}
	items := make([]DirItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		fullPath := filepath.Join(target, name)
		if isProtectedPath(fullPath) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, DirItem{
			Name:     name,
			Path:     fullPath,
			IsDir:    entry.IsDir(),
			Size:     info.Size(),
			MTime:    info.ModTime().UnixMilli(),
			IsHidden: strings.HasPrefix(name, "."),
		})
	}

	sortItems(items, opt.SortBy, opt.SortOrder)
	total := len(items)
	page := opt.Page
	pageSize := opt.PageSize
	if page > 0 && pageSize > 0 {
		if pageSize > 500 {
			pageSize = 500
		}
		start := (page - 1) * pageSize
		if start >= total {
			items = []DirItem{}
		} else {
			end := start + pageSize
			if end > total {
				end = total
			}
			items = items[start:end]
		}
	}

	parent := filepath.Dir(target)
	isRoot := parent == target
	if isRoot {
		parent = target
	}
	return DirList{Path: target, Parent: parent, Items: items, IsRoot: isRoot, ItemTotal: total, Page: page, PageSize: pageSize}, nil
}

func sortItems(items []DirItem, sortBy, sortOrder string) {
	desc := sortOrder == "descending" || sortOrder == "desc"
	sort.Slice(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}
		cmp := strings.Compare(strings.ToLower(items[i].Name), strings.ToLower(items[j].Name))
		switch sortBy {
		case "size":
			cmp = compareInt64(items[i].Size, items[j].Size)
		case "mtime", "modTime":
			cmp = compareInt64(time.UnixMilli(items[i].MTime).UnixMilli(), time.UnixMilli(items[j].MTime).UnixMilli())
		}
		if cmp == 0 {
			cmp = strings.Compare(strings.ToLower(items[i].Name), strings.ToLower(items[j].Name))
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
}

func compareInt64(a, b int64) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func isProtectedPath(target string) bool {
	clean := filepath.Clean(target)
	protected := []string{
		"/etc/1shell-probe-agent.env",
		"/opt/1shell/probe-agent",
	}
	for _, item := range protected {
		if clean == item || strings.HasPrefix(clean, item+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}
