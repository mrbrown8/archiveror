import {
    defaults, getArchivingURL, hasPageCapture, isLocal, makeFilename, sanitizeFilename, services, writeClipboard
} from "./utils.js";


function archive_is(url) {
    if (isLocal(url)) return;
    let request = new XMLHttpRequest();
    request.open("POST", "https://archive.is/submit/", true);
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    let params = "url=" + encodeURIComponent(url);
    request.onreadystatechange = function () {
        if (request.readyState === 4) {
            let link = request.response.match(/(https?:\/\/archive.is\/\w+)/)[0];
            // TODO: upgrade link to https
            postArchive(url, link);
        }
    };
    request.send(params);

    function postArchive(url, link) {
        chrome.storage.local.set({[url]: link}, function () {
            showArchive(url);
        });
    }
}

function archiveOnline(url, services) {
    // archive url online at services (a list of strings)
    if (isLocal(url)) return;  // don't archive internal pages, "file://", "chrome://", etc.
    let tabId, link;
    chrome.storage.local.get({archiveServices: defaults.archiveServices, email: defaults.email}, function (items) {
        if (services === undefined) {
            services = items.archiveServices;
        }
        for (let service of services) {
            link = getArchivingURL(url, service, items.email);

            chrome.tabs.create({url: link}, function (tab) {
                tabId = tab.id;
                // support updating clipboard with new link from archive.is "save the page again"
                chrome.tabs.onUpdated.addListener(URLToClipboard);
                chrome.tabs.onRemoved.addListener(URLToClipboard);
            });
        }
    });

    let re = /.*(?:archive|perma|webcitation)\.(?:is|cc|org).*/;
    function URLToClipboard(thisTabId, changeInfo, tab) {
        if (thisTabId !== tabId) {  // ignore other tabs
            return;
        }
        // remove listeners if the tab was closed and if user navigated away from archive
        if (changeInfo.hasOwnProperty("isWindowClosing") || !re.test(tab.url)) {
            chrome.tabs.onUpdated.removeListener(URLToClipboard);
            chrome.tabs.onRemoved.removeListener(URLToClipboard);
        } else {
            writeClipboard(tab.url);
        }
    }
}

// archive requests from popup
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.label === "archiveOnline") {
        archiveOnline(message.url, message.services);
    } else if (message.label === "saveLocal") {
        chrome.tabs.get(message.tabId, function (tab) {
            saveLocal(tab, false);
        });
    }
});

function showArchive(url, bookmark) {
    // Notify user if we have an archive of the current page, otherwise archive if needed
    let keys = {
        [url]: false,
        ["_" + url]: false,
        archiveBookmarks: defaults.archiveBookmarks,
        bookmarkServices: defaults.bookmarkServices
    };
    chrome.storage.local.get(keys, showBadge);

    function showBadge(items) {
        let taburl = url.split("#")[0];
        chrome.tabs.query({"url": taburl}, function (tabs) {
            let save = (items.archiveBookmarks === true);
            let title = buttonTitle.default + " (bookmark archived)";

            if (items[url] !== false) {
                changeBadge(tabs, title, "!", "#FFB90F");
            } else {
                if (save && items.bookmarkServices.includes("archive.is")) archive_is(url);
            }

            if (items["_" + url] !== false) {
                changeBadge(tabs, title, "!", "#FFB90F");
            } else {
                if (save && items.bookmarkServices.includes("mhtml")) {
                    downloadBlock.push(tabs[0].id);
                    getPath(bookmark, function (path) {
                        saveLocal(tabs[0], save, path);
                    });
                }
            }
        });
    }
}

function changeBadge(tabs, title, badgeText, badgeColor) {
    for (let t of tabs) {
        // Following changes reset automatically when the tab changes
        chrome.browserAction.setTitle({title: title, tabId: t.id});
        chrome.browserAction.setBadgeText({text: badgeText, tabId: t.id});
        chrome.browserAction.setBadgeBackgroundColor({color: badgeColor, tabId: t.id});
    }
}

const buttonTitle = {default: "Archiveror"};

function silentDownload(url, filename, path, callback) {
    // silently download to archiveDir
    chrome.storage.local.get({archiveDir: defaults.archiveDir}, function (items) {
        filename = items.archiveDir + path + filename;
        chrome.downloads.download({
            url: url, filename: filename, saveAs: false, conflictAction: "overwrite"}, callback);
    });
}

// When there's something in downloadBlock, moveLocal will wait on already
// moving the (unfinished!) download. This should also prevent bookmarkVisit
// from double archiving a page.
let downloadBlock = [];

function saveDownload(downloadId, url) {
    // save download id and path in local
    chrome.downloads.search({id: downloadId}, function (DownloadItems) {
        let download = DownloadItems[0];
        if (download.state === "complete") {
            let key = "_" + url;
            let value = {"id": download.id, "filename": download.filename};
            let data = {};
            data[key] = value;
            chrome.storage.local.set(data, function () {
                downloadBlock.pop(); // unblock moveLocal for bookmark creation
                showArchive(url);
            });
            chrome.downloads.setShelfEnabled(false); // hide download shelf
            window.setTimeout(function () {
                chrome.downloads.setShelfEnabled(true);
            }, 100);
        } else {
            // wait for 200ms, and try again
            window.setTimeout(saveDownload, 200, downloadId, url);
        }
    });
}

function saveLocal(tab, automatic, path) {
    // save page locally in MHTML format
    // ask user for input if automatic is false, else silently download
    if (tab.status !== "complete") {
        // Only save page after it has fully loaded
        changeBadge([tab], "Please wait!", "WAIT", "#d80f30");
        window.setTimeout(function () {
            chrome.tabs.get(tab.id, function (newTab) {
                saveLocal(newTab, automatic, path);
            });
        }, 200);
        return;
    }

    chrome.pageCapture.saveAsMHTML({tabId: tab.id}, blobToDisk);

    function blobToDisk(mhtmlData) {
        let filename = makeFilename(tab.title);
        let url = URL.createObjectURL(mhtmlData);
        if (automatic === true) {
            silentDownload(url, filename, path, function (downloadId) {
                saveDownload(downloadId, tab.url);
            });
        } else {
            chrome.downloads.download({url: url, filename: filename, saveAs: true});
        }
    }
}

// Keyboard shortcuts
chrome.commands.onCommand.addListener(function (command) {
    let action;
    if (command === "archive-page") {
        action = function (tabs) { archiveOnline(tabs[0].url); };
    } else if (command === "save-local") {
        action = function (tabs) { saveLocal(tabs[0], false); };
    }
    if (typeof action !== "undefined") {
        chrome.tabs.query({active: true, lastFocusedWindow: true}, action);
    }
});

// context menu
chrome.contextMenus.removeAll(function () {
    let menu = chrome.contextMenus.create({
        title: "Archive",
        id: "context-menu"
    });
    for (let service of services) {
        chrome.contextMenus.create({
            title: service,
            id: service,
            parentId: menu
        });
    }
    if (hasPageCapture) {
        chrome.contextMenus.create({type: "separator", id: "separator", parentId: menu});
        chrome.contextMenus.create({title: "Save MHTML as...", id: "MHTML", parentId: menu});
    }
});
chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === "MHTML") {
        saveLocal(tab, false);
    } else {
        archiveOnline(info.pageUrl, [info.menuItemId]);
    }
});

function newBookmark(id, bookmark) {
    if (bookmark.hasOwnProperty("url")) {
        showArchive(bookmark.url, bookmark);
    }
}
chrome.bookmarks.onCreated.addListener(newBookmark);

function getPath(bookmark, callback) {
    let nodes = [];
    getParent(bookmark);

    function getParent(bookmark) {
        chrome.bookmarks.get(bookmark.parentId, function (bookmarks) {
            let node = bookmarks[0];
            nodes.push(sanitizeFilename(node.title));
            if (node.parentId) {
                getParent(node);
            } else {
                callback(nodes.reverse().join("/") + "/");
            }
        });
    }
}

// On page visit (check if it's a bookmark)
function bookmarkVisit(tabId, changeInfo, tab) {
    if (changeInfo.status === "complete") {
        // prevent visit triggering a double archive download (on bookmark creation)
        // bug: doesn't always work...
        if (downloadBlock.indexOf(tabId) > -1) return;
        chrome.bookmarks.search({url: tab.url}, function (bookmarks) {
            if (bookmarks.length > 0 && bookmarks[0].url === tab.url) {
                showArchive(bookmarks[0].url, bookmarks[0]);
            }
        });
    }
}
chrome.tabs.onUpdated.addListener(bookmarkVisit);

function moveLocal(id, moveInfo) {
    // move local archives on bookmark moving
    if (downloadBlock.length > 0) {
        window.setTimeout(moveLocal, 300, id);
        return;
    }

    chrome.bookmarks.get(id, moveBookmark);

    function moveBookmark(bookmarks) {
        let bookmark = bookmarks[0];
        if (bookmark.hasOwnProperty("url")) {
            let key = "_" + bookmark.url;
            chrome.storage.local.get(key, function (items) {
                let data = items[key];
                // check if we need to move anything
                if (typeof data === "undefined") return;  // quit
                let downloadId = data.id;
                let url = data.filename;  // absolute file path
                let filename = makeFilename(bookmark.title);
                getPath(bookmark, function (path) {
                    silentDownload("file://" + url, filename, path, function (newId) {
                        chrome.downloads.removeFile(downloadId, function () {
                            downloadBlock.push(null);
                            saveDownload(newId, bookmark.url);
                        });
                    });
                });
            });
        } else {  // bookmark is a directory
            chrome.bookmarks.getChildren(bookmark.id, function (bookmarks) {
                for (let b of bookmarks) {
                    moveLocal(b.id);
                }
            });

        }
    }
}
chrome.bookmarks.onMoved.addListener(moveLocal);
chrome.bookmarks.onChanged.addListener(moveLocal);

function removeBookmark(id, removeInfo) {
    let node = removeInfo.node;

    if (node.hasOwnProperty("children")) {  // directory
        for (let child of node.children) {
            removeBookmark(child.id, {node: child});
        }
    } else {
        deleteBookmark(node);
    }

    function deleteBookmark(bookmark) {
        let url = bookmark.url;

        let key = "_" + url;
        chrome.storage.local.get(key, function (items) {
            // What if deleting the file fails?
            chrome.storage.local.remove(key);
            if (items.hasOwnProperty(key) && hasPageCapture) {
                chrome.downloads.removeFile(items[key].id);
            }
        });

        chrome.storage.local.remove(url);

        chrome.tabs.query({"url": url}, function (tabs) {
            changeBadge(tabs, buttonTitle.default, "", "#5dce2d");
        });
    }
}
chrome.bookmarks.onRemoved.addListener(removeBookmark);

// Remove deprecated "archiveMode" setting. TODO: remove this
chrome.runtime.onInstalled.addListener(function (details) {
    let key = "archiveMode";
    chrome.storage.local.get(key, function (items) {
        if (items[key]) {
            chrome.storage.local.remove(key);
        }
    });
});
