/**
 * Domain skills — per-site instruction packs that make the agent smarter on
 * specific websites.
 *
 * When the agent visits a site, matching skills are injected as
 * `<system-reminder>` blocks. Skills contain site-specific tips, shortcuts,
 * known-dangerous actions, and navigation patterns.
 *
 * Built-in skills: GitHub, Gmail, Amazon, Google Search, Twitter/X, LinkedIn,
 * Reddit. Users can add custom skills via chrome.storage.
 */

import { isExtensionWithLocal } from "./runtime";
import { neutralizePromptTags } from "./security";

/** Definition of a per-site instruction pack. */
export interface DomainSkill {
  /** Root domains to match (e.g. ["github.com"] or ["twitter.com", "x.com"]).
 * Changed from a single string to an array so multi-domain sites
 * (Twitter/X) don't require duplicate skill objects. */
  domains: string[];
  /** Human-readable site name (used in the prompt header). */
  name: string;
  /** Short description shown in the navigator's <available_skills> block (always in context). */
  frontmatter: string;
  /** Full instructions loaded on-demand via the load_skill action. */
  instructions: string;
  /** Actions that should require explicit user confirmation on this site. */
  dangerousActions?: string[];
  /** Quick-reference shortcuts (label → how-to). */
  shortcuts?: Record<string, string>;
}

/** Built-in skills for the 7 most common automation targets. */
export const BUILT_IN_SKILLS: readonly DomainSkill[] = [
  {
    domains: ["github.com"],
    name: "GitHub",
    frontmatter: "Tips for repos, issues, PRs, code search, branch management",
    instructions: `GitHub tips:
- To create an issue: navigate to the repo → click "Issues" tab → click "New issue"
- To search code: use the search bar at the top, or press "/" to focus it
- To switch branches: click the branch dropdown (usually says "main")
- Pull requests are in the "Pull requests" tab
- The "Code" button clones the repo — don't click it unless asked
- Markdown is used for issues, PRs, and comments

Official keyboard shortcuts (source: docs.github.com/en/get-started/accessibility/keyboard-shortcuts):
- Press "?" anywhere on GitHub to see all shortcuts for the current page
- "S" or "/" → Focus the search bar
- "G N" → Go to notifications
- "G C" → Go to the Code tab
- "G I" → Go to the Issues tab
- "G P" → Go to the Pull requests tab
- "G A" → Go to the Actions tab
- "G W" → Go to the Wiki tab
- "G G" → Go to the Discussions tab
- "G S" → Go to the Security and quality tab
- "." → Open repo in github.dev editor (same tab)
- ">" → Open repo in github.dev editor (new tab)
- "t" → File finder
- "l" → Jump to line
- "w" → Switch to a new branch or tag
- "y" → Expand URL to its canonical (permanent) form
- "i" → Show or hide comments on diffs
- "a" → Show or hide annotations on diffs
- "b" → Open blame view
- Command palette: "Ctrl+K" (Windows/Linux) or "Cmd+K" (Mac)
- "Cmd/Ctrl+Enter" → Submit a comment
- "C" → Create an issue
- "Cmd/Ctrl+/" → Focus the issues or pull requests search bar
- "Q" → Request a reviewer
- "M" → Set a milestone
- "L" → Apply a label
- "A" → Set an assignee
- "X" → Link an issue or pull request
- "Cmd/Ctrl+Z" → Undo, "Cmd/Ctrl+Y" → Redo
- "Cmd/Ctrl+S" → Write a commit message
- "E" → Open source code file in the Edit file tab
- Markdown in comments: "Cmd/Ctrl+B" bold, "Cmd/Ctrl+I" italic, "Cmd/Ctrl+K" link, "Cmd/Ctrl+Shift+7" ordered list, "Cmd/Ctrl+Shift+8" unordered list, "Cmd/Ctrl+Shift+." quote
- "R" → Quote selected text in your reply
- "g f" → Go to workflow file (Actions)
- "Shift+T" or "T" → Toggle timestamps in Actions logs
- "Shift+F" or "F" → Toggle full-screen logs in Actions
- "Option+Shift+c" (Mac) / "Alt+Shift+c" (Windows/Linux) → Create a new sub-issue
- Option+Shift+a → Add an existing issue as sub-issue
- Option+Shift+p → Edit parent issue
- In PR diff view: "J"/"K" move selection, "Shift+Enter" add single comment, "Alt+click" toggle collapse of outdated review comments
- "Shift+J" highlights the current line in code files
- "Shift+Alt+C" opens the line menu for the selected line
- "Cmd/Ctrl+Enter" submits a comment in the PR diff view
- For project boards (classic): "Enter"/"Space" start moving a card, "Esc" cancels, arrow keys move cards between columns
- For the network graph: "H"/"L" scroll left/right, "K"/"J" scroll up/down, "Shift+H"/"Shift+L"/"Shift+K"/"Shift+J" scroll all the way in that direction
- For project boards: "Enter"/"Space" start moving a card, "Esc" cancels, arrow keys move cards between columns, "e" archive selected items
- Command palette search modes: "#" searches issues/PRs/discussions, "@" searches users/orgs/repos, "/" searches files, "!" searches projects
- "Cmd/Ctrl+C" in command palette copies the navigation URL for the highlighted result`,
    dangerousActions: ["delete repository", "force push", "delete branch", "merge pull request", "close issue without comment"],
    shortcuts: {
      "create issue": "Click Issues tab → New issue (or press C in the issue list)",
      "create PR": "Click Pull requests tab → New pull request",
      "search code": "Press / to focus search bar",
      "open in editor": "Press . to open github.dev, > to open in new tab",
      "permanent link": "Press y on any file to get a canonical SHA-based URL",
      "command palette": "Press cmd+k (Mac) or ctrl+k (Windows/Linux)",
      "go to section": "g c = Code, g i = Issues, g p = PRs, g a = Actions, g w = Wiki, g g = Discussions, g s = Security",
      "file finder": "Press t to fuzzy-find files in the current repo",
      "jump to line": "Press l then type line number, or Alt+g then type line number",
      "switch branch": "Press w to switch branches/tags",
      "toggle comments": "Press i to show/hide diff comments",
      "submit comment": "cmd+enter (Mac) or ctrl+enter (Windows/Linux)",
      "request reviewer": "Press q when focused on a PR",
      "set assignee": "Press a when filtering issues/PRs",
      "set milestone": "Press m when filtering issues/PRs",
      "apply label": "Press l when filtering issues/PRs",
      "link issue/PR": "Press x when viewing an issue or PR",
      "undo": "cmd+z (Mac) or ctrl+z (Windows/Linux)",
      "redo": "cmd+y (Mac) or ctrl+y (Windows/Linux)",
      "write commit": "cmd+s (Mac) or ctrl+s (Windows/Linux)",
      "bold (markdown)": "cmd+b (Mac) or ctrl+b (Windows/Linux)",
      "italic (markdown)": "cmd+i (Mac) or ctrl+i (Windows/Linux)",
      "inline code (markdown)": "cmd+e (Mac) or ctrl+e (Windows/Linux)",
      "link (markdown)": "cmd+k (Mac) or ctrl+k (Windows/Linux)",
      "quote (markdown)": "cmd+shift+. (Mac) or ctrl+shift+. (Windows/Linux)",
      "sub-issue": "Option+Shift+c (Mac) or Alt+Shift+c (Windows/Linux)",
      "toggle fullscreen logs": "Shift+f in GitHub Actions logs",
      "edit file": "Press E on a source code file to open the Edit file tab",
      "search in file": "cmd+f (Mac) or ctrl+f (Windows/Linux) in file editor",
      "find next": "cmd+g (Mac) or ctrl+g (Windows/Linux)",
      "find previous": "cmd+shift+g (Mac) or ctrl+shift+g (Windows/Linux)",
      "replace in file": "cmd+option+f (Mac) or ctrl+shift+f (Windows/Linux)",
      "replace all in file": "cmd+shift+option+f (Mac) or ctrl+shift+r (Windows/Linux)",
      "toggle edit/preview": "cmd+shift+p (Mac) or ctrl+shift+p (Windows/Linux)",
      "highlight current line": "Shift+j in code files",
      "line menu": "Shift+option+c (Mac) or Shift+alt+c (Windows/Linux)",
      "open issue/PR": "Press O or Enter in issue/PR list",
      "filter by author": "Press U in issue/PR list",
      "workflow suggestions": "cmd+space (Mac) or ctrl+space (Windows/Linux) in workflow editor",
      "network graph scroll": "H/L scroll left/right, K/J scroll up/down, Shift+arrows scroll all the way",
      "project board move": "Enter/Space to start moving a card, Esc to cancel, arrows to move between columns",
      "commits dropdown": "Press C in Files Changed tab to filter commits",
      "filter changed files": "Press T in Files Changed tab to focus filter field",
      "single comment": "Shift+Enter to add a single comment in PR diff view",
      "collapse outdated": "Alt+click to toggle collapse of outdated review comments",
      "copy navigation url": "Cmd+c (Mac) or Ctrl+c in command palette copies the URL",
    },
  },
  {
    domains: ["mail.google.com"],
    name: "Gmail",
    frontmatter: "Tips for compose, reply, search, labels, attachments",
    instructions: `Gmail tips:
- To compose: click the "Compose" button (top-left) or press "c"
- To reply: click "Reply" at the bottom of an email or press "r"
- To search: use the search bar at the top, supports operators like "from:", "subject:", "has:attachment"
- To archive: click the archive icon (box with down arrow) or press "e"
- To delete: click the trash icon or press "#"
- Labels are on the left sidebar
- The "Send" button is blue, at the bottom of the compose window

Official keyboard shortcuts (source: support.google.com/mail/answer/6594):
- Keyboard shortcuts must be enabled in Settings → General → Keyboard shortcuts
- Press "?" when Gmail is open to see the full list of shortcuts
- "c" → Compose new email, "d" → Compose in new tab
- "r" → Reply, "a" → Reply all, "f" → Forward
- "e" → Archive, "#" → Delete, "!" → Report spam
- "/" → Focus search bar, "q" → Search chat contacts
- "g i" → Go to Inbox, "g s" → Go to Starred, "g t" → Go to Sent, "g d" → Go to Drafts, "g a" → Go to All Mail, "g k" → Go to Tasks, "g l" → Go to label
- "k" → Newer conversation, "j" → Older conversation, "o" or "Enter" → Open conversation
- "u" → Back to threadlist, "x" → Select conversation, "s" → Star/Unstar
- "z" → Undo last action, "y" → Move to Tasks
- "Shift+i" → Mark as read, "Shift+u" → Mark as unread, "_" → Mark unread from selected message
- "Cmd/Ctrl+Enter" → Send email
- "Cmd/Ctrl+Shift+c" → Add cc, "Cmd/Ctrl+Shift+b" → Add bcc
- "Cmd/Ctrl+k" → Insert a link, "Cmd/Ctrl+b" → Bold, "Cmd/Ctrl+i" → Italics, "Cmd/Ctrl+u" → Underline
- "Cmd/Ctrl+Shift+7" → Numbered list, "Cmd/Ctrl+Shift+8" → Bulleted list, "Cmd/Ctrl+Shift+9" → Quote
- "Cmd/Ctrl+[" → Indent less, "Cmd/Ctrl+]" → Indent more
- "Cmd/Ctrl+Shift+l" → Align left, "Cmd/Ctrl+Shift+e" → Align center, "Cmd/Ctrl+Shift+r" → Align right
- "Cmd/Ctrl+\\" → Remove formatting
- "Shift+r" → Reply in new window, "Shift+a" → Reply all in new window, "Shift+f" → Forward in new window
- "Shift+n" → Update conversation, "]" or "[" → Archive conversation and go previous/next
- "Shift+t" → Add conversation to Tasks, "m" → Mute
- "Tab" → Move forward between interactive elements, "Shift+Tab" → Move backward
- "Enter" → Activate the currently focused element
- "Shift+Esc" → Focus the main window
- "Esc" → Focus the latest chat or compose
- "Ctrl+." → Advance to the next chat or compose, "Ctrl+," → Advance to previous
- "." → Open the "more actions" menu, "v" → Open the "move to" menu, "l" → Open the "label as" menu
- "*" then "a" → Select all conversations, "*" then "n" → Deselect all, "*" then "r" → Select read, "*" then "u" → Select unread, "*" then "s" → Select starred, "*" then "t" → Select unstarred

Note: On PCs, use "Ctrl" instead of "⌘". On Mac, use "⌘". Shortcuts must be enabled in Settings → General → Keyboard shortcuts.`,
    dangerousActions: ["send email", "delete all emails", "forward to external address", "change password"],
    shortcuts: {
      "compose": "Click Compose button (top-left) or press c",
      "compose new tab": "Press d to compose in a new tab",
      "search": "Click search bar or press /",
      "reply": "Click Reply at bottom of email or press r",
      "reply all": "Press a to reply all",
      "forward": "Press f to forward",
      "archive": "Press e to archive selected email",
      "delete": "Press # to delete selected email",
      "send": "cmd+enter (Mac) or ctrl+enter (Windows/Linux)",
      "navigate newer": "Press k for newer conversation",
      "navigate older": "Press j for older conversation",
      "open conversation": "Press o or Enter to open",
      "back to threadlist": "Press u to return to thread list",
      "select conversation": "Press x to select/deselect",
      "star": "Press s to star/unstar",
      "undo": "Press z to undo last action",
      "spam": "Press ! to report as spam",
      "mute": "Press m to mute conversation",
      "mark as read": "Shift+i",
      "mark as unread": "Shift+u",
      "mark important": "Press + or = to mark as important",
      "mark not important": "Press - to mark as not important",
      "expand conversation": "Press ; to expand entire conversation",
      "collapse conversation": "Press : to collapse entire conversation",
      "archive and navigate": "Press ] to archive and go next, [ to go previous",
      "add to tasks": "Shift+t",
      "previous message": "Press p for previous message in open conversation",
      "next message": "Press n for next message in open conversation",
      "shortcut help": "Press ? to see all shortcuts",
      "more actions menu": "Press . to open more actions",
      "move to menu": "Press v to open move-to menu",
      "label as menu": "Press l to open label-as menu",
      "focus main window": "Shift+Esc",
      "go to inbox": "g then i",
      "go to starred": "g then s",
      "go to snoozed": "g then b",
      "go to sent": "g then t",
      "go to drafts": "g then d",
      "go to all mail": "g then a",
      "go to tasks": "g then k",
      "go to label": "g then l",
      "go to next page": "g then n",
      "go to previous page": "g then p",
      "save draft": "Ctrl+s",
      "bold": "Cmd+b (Mac) or Ctrl+b (Windows/Linux)",
      "italic": "Cmd+i (Mac) or Ctrl+i (Windows/Linux)",
      "underline": "Cmd+u (Mac) or Ctrl+u (Windows/Linux)",
      "indent less": "Cmd+[ (Mac) or Ctrl+[ (Windows/Linux)",
      "indent more": "Cmd+] (Mac) or Ctrl+] (Windows/Linux)",
      "align left": "Cmd+Shift+l (Mac) or Ctrl+Shift+l (Windows/Linux)",
      "align center": "Cmd+Shift+e (Mac) or Ctrl+Shift+e (Windows/Linux)",
      "align right": "Cmd+Shift+r (Mac) or Ctrl+Shift+r (Windows/Linux)",
      "remove formatting": "Cmd+\\ (Mac) or Ctrl+\\ (Windows/Linux)",
      "new window reply": "Shift+r",
      "new window reply all": "Shift+a",
      "new window forward": "Shift+f",
      "insert link": "Cmd+k (Mac) or Ctrl+k (Windows/Linux)",
      "spelling suggestions": "Cmd+m (Mac) or Ctrl+m (Windows/Linux)",
      "select all": "* then a",
      "deselect all": "* then n",
      "select read": "* then r",
      "select unread": "* then u",
    },
  },
  {
    domains: ["amazon.com"],
    name: "Amazon",
    frontmatter: "Tips for search, cart, checkout, product pages, reviews",
    instructions: `Amazon tips:
- To search: use the search bar at the top
- To add to cart: click "Add to Cart" (yellow/orange button) or press "shift+opt+K" (Mac) / "shift+alt+K" (PC) on product pages
- To view cart: click "Cart" (top-right) or press "shift+opt+C" (Mac) / "shift+alt+C" (PC)
- To checkout: click "Proceed to checkout" (yellow button)
- Product reviews are at the bottom of the product page
- "Buy Now" skips the cart — be careful
- Prices are shown with $ and may include "Prime" badge

Official keyboard shortcuts (source: amazon.com/gp/help/customer/display.html — Navigation Assistant):
- The Navigation Assistant provides keyboard-accessible menus on Amazon shopping pages (desktop only)
- "shift+opt+Z" (Mac) / "shift+alt+Z" (PC) → Open or close the Navigation Assistant
- "opt+/" (Mac) / "alt+/" (PC) → Focus the search bar
- "shift+opt+C" (Mac) / "shift+alt+C" (PC) → Navigate to Cart
- "shift+opt+H" (Mac) / "shift+alt+H" (PC) → Navigate to Amazon Homepage
- "shift+opt+O" (Mac) / "shift+alt+O" (PC) → Navigate to Your Orders
- "shift+opt+K" (Mac) / "shift+alt+K" (PC) → Add to Cart (on product detail pages)
- "shift+opt+D" (Mac) / "shift+alt+D" (PC) → Navigate to Product Summary
- "Tab" → Move forward between interactive elements on any Amazon shopping page
- "Shift+Tab" → Move backward between interactive elements
- Up/Down arrows → Navigate items in the Navigation Assistant menu
- "Enter" → Activate a link in the Navigation Assistant
- "Escape" → Close the Navigation Assistant and return focus to the previous element
- The "Your Shortcuts" panel is also accessible from the hamburger menu (three horizontal lines) at the bottom of the Amazon shopping app on mobile`,
    dangerousActions: ["buy now", "proceed to checkout", "one-click buy", "change payment method", "change shipping address"],
    shortcuts: {
      "search": "Type in search bar at top or opt+/ (Mac) / alt+/ (PC)",
      "add to cart": "Click Add to Cart button or shift+opt+K (product pages, Mac)",
      "view cart": "Click Cart at top-right or shift+opt+C (Mac)",
      "view orders": "shift+opt+O (Mac)",
      "homepage": "shift+opt+H (Mac)",
      "navigation assistant": "shift+opt+Z (Mac) to show/hide the shortcuts menu",
      "product summary": "shift+opt+D (Mac)",
      "buy now": "Use with caution — skips the cart",
    },
  },
  {
    domains: ["google.com"],
    name: "Google Search",
    frontmatter: "Tips for search results, pagination, search operators",
    instructions: `Google Search tips:
- To search: type in the search box and press Enter or click "Google Search"
- Search results show title (blue link), URL (green), and snippet (gray text)
- To go to a result: click the blue title link
- To go to next page: click "Next" at the bottom
- Tabs: All, Images, News, Videos, Maps — click to switch
- "I'm Feeling Lucky" goes directly to the first result

Search operators (source: support.google.com/websearch/answer/2466433):
- Use quotes for exact match: "exact phrase"
- Use minus to exclude: -site:youtube.com
- Use "site:" to search within a specific site: site:wikipedia.org
- Use "OR" for alternatives: pasta OR noodles
- Use "define:" for definitions: define:ephemeral
- Use "weather" to get local weather: weather seattle
- Use "stock:" for stock info: stock:AAPL
- Use "timer:" for a timer: timer 5 minutes
- Use "calculator:" for math: calculator 15% of 240
- Use "units:" for conversions: units 10 miles in km
- Use "before:YYYY-MM-DD" to find documents before a specific date
- Use "after:YYYY-MM-DD" to find documents after a specific date
- Use "filetype:ext" to find documents of a specific file type (e.g. filetype:pdf)
- "intitle:" to find pages with a word in the title
- "inurl:" to find pages with a word in the URL
- "related:" to find sites similar to a given URL

Navigation tips:
- Ctrl+L (Mac: cmd+L) → Jump to the address/search bar
- Ctrl+k or Ctrl+e → Open search bar from anywhere on the page
- Tab → Cycle through search suggestions
- Arrow keys → Navigate search suggestions
- Click "Tools" below the search bar to filter by time, image type, usage rights, etc.
- Press "/" when on the search results page to focus a new search`,
    shortcuts: {
      "search": "Type in search box, press Enter",
      "next page": "Click Next at bottom",
      "focus search bar": "Press / on any Google page or Ctrl+k / Cmd+L",
      "exact match": "Wrap terms in quotes like \"exact phrase\"",
      "exclude": "Use minus sign: -site:example.com",
      "site search": "site:wikipedia.org python",
      "define": "define:word",
      "weather": "weather city name",
      "convert": "units 10 miles in km",
      "timer": "timer 5 minutes",
      "calculator": "calculator 15% of 240",
      "tools filter": "Click Tools below search bar for time/image/usage filters",
      "iam feeling lucky": "Click I'm Feeling Lucky or press Enter after typing",
      "filetype filter": "filetype:pdf to find PDF documents",
      "date filter": "before:2024-01-01 to find results before a date",
      "intitle filter": "intitle:keyword to find pages with word in title",
      "related search": "related:example.com to find similar sites",
    },
  },
  {
    domains: ["twitter.com", "x.com"],
    name: "Twitter/X",
    frontmatter: "Tips for posting, replying, searching, profile navigation",
    instructions: `Twitter/X tips:
- To post: click "Post" (blue button) → type → click "Post" again, or press "n"
- To reply: click the reply icon (speech bubble) under a tweet, or press "r"
- To like: click the heart icon, or press "l"
- To retweet: click the retweet icon (two arrows), or press "t"
- To share: press "s" when focused on a tweet
- The search bar is at the top-right, or press "/"
- Your profile is accessible by clicking your avatar, or press "g" then "p"
- Direct messages are in the envelope icon, or press "g" then "m"

Keyboard shortcuts (source: x.com official help docs + Computer Hope + keycombiner.com):
- "?" → Open the full keyboard shortcut menu/cheatsheet
- "n" → Compose a new tweet (from anywhere on X)
- "c" → Compose a new tweet (alternative)
- "r" → Reply to the selected tweet
- "t" → Retweet/repost the selected tweet
- "l" → Like/unlike the selected tweet
- "m" → Send a direct message
- "s" → Share a tweet
- "x" → Block the selected user
- "b" → Bookmark the selected tweet
- "u" → Mute/unmute the selected user
- "o" → Expand a photo or video in the tweet
- "/" → Focus the search bar
- "Enter" → Open tweet details
- "Esc" → Close any open modal (reply box, DM window, profile overlay)
- "Cmd+Enter" (Mac) / "Ctrl+Enter" (Windows/Linux) → Send tweet
- "Shift+J" → Scroll down to the next tweet (precise tweet-aligned movement)
- "Shift+K" → Scroll up to the previous tweet (precise tweet-aligned movement)
- "g h" → Go to Home timeline
- "g n" → Go to Notifications
- "g m" → Go to Direct Messages
- "g p" → Go to your Profile
- "g l" → Go to Likes
- "g i" → Go to Lists
- "g b" → Go to Bookmarks
- "g r" → Go to Mentions
- "g s" → Go to Settings and privacy
- "g u" → Go to another user's profile
- "g o" → Go to Moments (older UI)
- "g e" → Go to Explore (older UI)
- "j" / "↓" → Next tweet in the feed
- "k" / "↑" → Previous tweet in the feed
- "." → Load new tweets
- "Space" → Page down
- "Shift+Space" → Page up

Navigation tips:
- Use the left sidebar to navigate between Home, Explore, Notifications, Messages, Bookmarks, Lists, Profile
- Click the gear icon (⚙) in the left sidebar for Settings and privacy
- On a tweet, click the three dots (⋯) for options like Copy link, Tweet context, Embed Tweet, Report, Mute, Block
- Long-press a tweet (on mobile) to see quick actions
- The "Verified" badge (blue check) indicates the account has X Premium`,
    dangerousActions: ["post tweet", "send direct message", "delete tweet", "block user", "change account settings"],
    shortcuts: {
      "post": "Click the Post button (blue) or press n",
      "reply": "Click the speech bubble icon or press r",
      "like": "Click the heart icon or press l",
      "retweet": "Click the retweet icon or press t",
      "share": "Press s when focused on a tweet",
      "search": "Click the search bar or press /",
      "compose": "Press n (or c) from anywhere on X",
      "next tweet": "Press j or down arrow",
      "previous tweet": "Press k or up arrow",
      "send tweet": "Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux)",
      "block user": "Press x when focused on a tweet",
      "bookmark tweet": "Press b when focused on a tweet",
      "mute user": "Press u when focused on a tweet",
      "expand media": "Press o when focused on a tweet",
      "close modal": "Press Esc to close reply box, DM window, or profile overlay",
      "scroll to tweet": "Shift+j to scroll down, Shift+k to scroll up (precise tweet-aligned)",
      "home timeline": "g then h",
      "notifications": "g then n",
      "messages": "g then m",
      "profile": "g then p",
      "likes": "g then l",
      "lists": "g then i",
      "bookmarks": "g then b",
      "mentions": "g then r",
      "settings": "g then s",
      "cheatsheet": "Press ? to see all shortcuts",
      "load new tweets": "Press . to refresh the feed",
      "page down": "Space",
      "page up": "Shift+Space",
    },
  },
  {
    domains: ["linkedin.com"],
    name: "LinkedIn",
    frontmatter: "Tips for profile, connections, job applications, messaging",
    instructions: `LinkedIn tips:
- To search: use the search bar at the top
- To connect: click "Connect" on a profile
- To message: click "Message" on a profile
- Your profile is under "Me" (your avatar, top-right)
- Jobs are under the "Jobs" tab
- "Easy Apply" lets you apply with one click — be careful

Official keyboard shortcuts (source: linkedin.com/help/linkedin/answer/a6246187):
- Press "Shift+?" anywhere on LinkedIn to open the hotkeys cheat sheet modal
- Press "Tab" to activate the menu, then toggle hotkeys on or off
- "n" → New post (open the sharebox on the feed)
- "j" → Next article in the feed
- "k" → Previous article in the feed
- "l" → Like a post (when focused on a post)
- "c" → Comment on a post (when focused on a post)
- "r" → Repost/reshare a post (when focused on a post)
- "s" → Send a message (when focused on a post or profile)
- "/" → Focus the search bar
- "g h" → Home feed
- "g w" → My Network
- "g j" → Jobs
- "g m" → Messaging
- "g n" → Notifications
- "g p" → Me (your profile)
- Tab → Navigate between interactive elements
- Enter → Activate the currently focused element

Notifications:
- "j" → Next notification
- "k" → Previous notification

LinkedIn Learning video shortcuts:
- Space → Toggle play/pause
- Left arrow → Scrub back 10 seconds
- Right arrow → Scrub forward 10 seconds
- m → Mute
- f → Enter full screen
- Up arrow → Increase volume
- Down arrow → Decrease volume
- c → Toggle captions

Navigation tips:
- The left sidebar contains: Home, My Network, Jobs, Messaging, Notifications, Menu (⋯)
- Use "Open to Work" or "Premium" badges on profiles to understand member status
- The "About" section on a company page shows key details (size, industry, website)
- "Easy Apply" is available for many jobs — it pre-fills your profile info but can reduce your chances at competitive companies
- Connection requests can include a note — personalize it for better acceptance rates
- Keyboard shortcuts are only available on Desktop (not mobile)`,
    dangerousActions: ["connect with someone", "send message", "easy apply", "endorse skills", "recommend someone"],
    shortcuts: {
      "search": "Click the search bar at the top or press /",
      "connect": "Click \"Connect\" button on a profile",
      "message": "Click \"Message\" button on a profile",
      "new post": "Press n from the feed",
      "like": "Press l when focused on a post",
      "comment": "Press c when focused on a post",
      "repost": "Press r when focused on a post",
      "send": "Press s when focused on a post or profile",
      "next article": "Press j to navigate down the feed",
      "previous article": "Press k to navigate up the feed",
      "next notification": "Press j in notifications",
      "previous notification": "Press k in notifications",
      "home": "g then h",
      "my network": "g then w",
      "jobs": "g then j",
      "messaging": "g then m",
      "notifications": "g then n",
      "my profile": "g then p",
      "cheatsheet": "Shift+? to open the shortcuts help modal",
      "toggle hotkeys": "Press Tab to activate menu, then toggle keyboard shortcuts on/off",
      "easy apply": "One-click apply on job listings — use with caution",
      "toggle play/pause": "Space (LinkedIn Learning videos)",
      "mute learning video": "m (LinkedIn Learning videos)",
      "fullscreen learning video": "f (LinkedIn Learning videos)",
      "scrub back": "Left arrow (LinkedIn Learning videos)",
      "scrub forward": "Right arrow (LinkedIn Learning videos)",
      "increase volume": "Up arrow (LinkedIn Learning videos)",
      "decrease volume": "Down arrow (LinkedIn Learning videos)",
      "toggle captions": "c (LinkedIn Learning videos)",
    },
  },
  {
    domains: ["reddit.com"],
    name: "Reddit",
    frontmatter: "Tips for subreddits, posts, comments, search",
    instructions: `Reddit tips:
- To search: use the search bar at the top
- To upvote/downvote: click the up/down arrows next to a post
- To comment: click "Add a comment" at the bottom of a post
- Subreddits are in the left sidebar
- Sort options: Hot, New, Top, Rising — at the top of the feed
- To create a post: click "Create Post" (top-right)

Official keyboard shortcuts (source: support.reddithelp.com/hc/en-us/articles/38744650091412 — Reddit Help, dated 2026-03-28):
- Press "Shift+?" anywhere on Reddit to see all available shortcuts
- Hotkeys are active by default on Reddit's desktop web (most recent reddit.com interface only, not available on old Reddit)
- You can view all available shortcuts and disable/enable them from the hotkeys helper panel

Navigation:
- "Shift+?" → Show the shortcuts helper panel
- "j" → Next post or comment
- "k" → Previous post or comment
- "n" → Next post in lightbox
- "p" → Previous post in lightbox
- "Enter" → Open a post
- "x" → Open or close expando (compact mode)
- "l" → Go to post link

Actions:
- "a" → Upvote
- "z" → Downvote
- "c" → Create a new post
- "r" → Reply to a comment
- "Cmd+Enter" (Mac) / "Ctrl+Enter" (Windows/Linux) → Submit comment or post
- "s" → Save/unsave a post or comment
- "h" → Hide a post
- "q" → Open/close navigation sidebar
- "Enter" → Collapse or expand a comment (when focused)

Media controls (when viewing images/videos):
- Space → Play/Pause
- f → Toggle fullscreen mode
- Arrow keys → Seek within media
- "m" → Mute/unmute

Navigation tips:
- The left sidebar shows subreddits you're subscribed to plus shortcuts to Popular, All, and other views
- Use "Sort" (Hot/New/Top/Rising/Controversial) to change how posts are ordered
- Click a post title to open it; click the score or comments count to expand the comment thread
- Expanding comments loads more of the thread — click "x more comments" to load additional replies
- Use "hide" (press h) to remove posts from your view temporarily
- Reddit Premium members get ad-free browsing and access to r/lounge
- These shortcuts only work on the most recent reddit.com interface (not "old Reddit")`,
    dangerousActions: ["post to subreddit", "send private message", "delete post", "ban user (mod only)"],
    shortcuts: {
      "upvote": "Press a on a post or comment",
      "downvote": "Press z on a post or comment",
      "save": "Press s to save/unsave a post or comment",
      "hide": "Press h to hide a post",
      "create post": "Click Create Post (top-right) or press c",
      "reply": "Press r when focused on a comment",
      "submit comment": "cmd+enter (Mac) or ctrl+enter (Windows/Linux)",
      "search": "Type in the search bar at the top",
      "show shortcuts": "Press Shift+? to see all available shortcuts",
      "next post": "Press j to navigate to next post or comment",
      "previous post": "Press k to navigate to previous post or comment",
      "next lightbox": "Press n for next post in lightbox",
      "previous lightbox": "Press p for previous post in lightbox",
      "open post": "Press Enter when focused on a post",
      "open expando": "Press x in compact mode",
      "go to post link": "Press l when focused on a post",
      "toggle sidebar": "Press q to show/hide subreddit navigation",
      "play/pause media": "Space when viewing images/videos",
      "toggle fullscreen": "Press f on media",
      "seek media": "Arrow keys to seek within media",
      "mute media": "Press m on media",
      "toggle captions": "Press c on media",
      "collapse comment": "Press Enter when focused on a comment",
    },
  },
] as const;

/**
 * Pre-normalized domain cache. Domains are normalized once at load time (for
 * built-ins) or at custom-skill normalization time, then reused on every
 * `hostnameMatches` call. This avoids re-running toLowerCase + 4 replace
 * calls per domain per navigation step.
 */
const normalizedDomainCache = new Map<string, string>();

function normalizeDomainForMatch(domain: string): string {
  const cached = normalizedDomainCache.get(domain);
  if (cached !== undefined) return cached;
  let d = domain.toLowerCase().trim();
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/\/.*$/, "");
  d = d.replace(/:\d+$/, "");
  d = d.replace(/^\.+/, "");
  d = d.replace(/\.+$/, "");
  normalizedDomainCache.set(domain, d);
  return d;
}

// Pre-normalize built-in skill domains at module load.
for (const skill of BUILT_IN_SKILLS) {
  for (const domain of skill.domains) {
    normalizeDomainForMatch(domain);
  }
}

/**
 * Names of all built-in skills. A custom skill that reuses one of these names is
 * unreachable: `getFullSkill` resolves built-ins first by exact name, so the
 * custom body would be silently dead while the agent receives the bundled
 * instructions for a possibly-different (private) host. Custom skills with a
 * colliding name are dropped during normalization (`null` → skipped by the
 * caller), which is safer than letting the navigator list an unloadable skill.
 */
const BUILT_IN_SKILL_NAMES = new Set(BUILT_IN_SKILLS.map((s) => s.name));

/**
 * Non-XML boundary delimiter for custom-skill content. Custom skills are
 * attacker-influenced data that flows into the TRUSTED system prompt. The
 * primary defense is {@link neutralizePromptTags} (derived from PROMPT_TAGS),
 * which rewrites every prompt-level XML tag. This delimiter adds a SECOND
 * layer: it uses plain ASCII (`===`) that is not an XML tag, so
 * neutralizePromptTags cannot accidentally break it and an attacker cannot
 * forge it as an XML boundary. The message builder should strip this
 * delimiter before injecting the content; if it doesn't, the delimiter is
 * harmless visible text that the LLM ignores.
 */
const SKILL_BOUNDARY = "=== SKILL START ===\n";
const SKILL_BOUNDARY_END = "\n=== SKILL END ===";

/**
 * Test whether `hostname` matches `domain` (exact match or subdomain).
 *
 * NOTE: suffix matching (`h.endsWith("." + d)`) means a skill scoped to
 * "github.com" will also fire on gist.github.com, api.github.com, etc.
 * This is intentional for built-in skills (multi-domain sites like
 * twitter.com/x.com need subdomain coverage), but for CUSTOM skills it
 * means site-specific instructions designed for one subdomain are injected
 * on ALL subdomains of the same root domain — potentially leaking
 * site-specific guidance to attacker-controlled hosts under the same root.
 * The PUBLIC_SUFFIX_DOMAINS blocklist mitigates the worst shared-suffix
 * cases (co.uk, github.io) but does not cover every possible multi-tenant
 * domain. Users should be aware that a custom skill targeting "example.com"
 * will also fire on any subdomain of example.com.
 */
function hostnameMatches(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase();
  const d = normalizeDomainForMatch(domain);
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Single-label domains (no '.') like a bare TLD (`com`) would, via
 * `hostnameMatches`, match *every* host under that TLD (`.com` → matches all
 * of `evil.com`, `bank.com`, …) — an accidental over-match that would inject a
 * custom skill's (untrusted, prompt-flowing) instructions onto far more sites
 * than intended. Reject them for the subdomain-matching fallback, but keep a
 * small allowlist of legitimate single-label hosts (e.g. `localhost`) so
 * local-dev skills still resolve. A dotted domain (or exact-match single label)
 * passes.
 */
const LOCAL_SINGLE_LABEL_HOSTS = new Set(["localhost"]);
// Curated subset of multi-label public suffixes. A custom-skill domain that
// IS itself a public suffix (not a specific host under it) would, via
// `hostnameMatches`, match *every* site on that suffix — e.g. a skill scoped
// to `co.uk` injects instructions on all of `evil.co.uk`, `bank.co.uk`, …
// `isValidSkillDomain` therefore rejects domains that are exactly a known
// public suffix. (A full PSL is overkill here; this blocks the dangerous
// shared-suffix cases a custom skill could abuse.)
const PUBLIC_SUFFIX_DOMAINS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "github.io", "gitlab.io",
  "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "herokuapp.com", "amazonaws.com", "azurewebsites.net", "googleapis.com",
  "appspot.com", "firebaseapp.com", "blogspot.com", "wordpress.com",
]);
function isValidSkillDomain(domain: string): boolean {
  if (PUBLIC_SUFFIX_DOMAINS.has(domain.toLowerCase())) return false;
  return domain.includes(".") || LOCAL_SINGLE_LABEL_HOSTS.has(domain);
}

/** Storage key under which custom skills are persisted. */
const CUSTOM_SKILLS_STORAGE_KEY = "open_cowork_custom_skills";

/**
 * Read user-defined custom domain skills from chrome.storage.local.
 * Returns an empty array in non-extension contexts (e.g. the in-page demo)
 * or when storage is unavailable. Internal helper — callers should use
 * {@link getDomainSkills} which merges built-in + custom skills.
 */
// module-level cache for custom domain skills.
let customSkillsCache: DomainSkill[] | null = null;

if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CUSTOM_SKILLS_STORAGE_KEY]) {
      customSkillsCache = null;
    }
  });
}

/**
 * Length caps for custom-skill content. Custom skills are attacker-influenced
 * data (anyone with write access to `chrome.storage.local`) that flows into the
 * TRUSTED system prompt, so unbounded content is a token-bloat / cost-DoS
 * vector. These caps bound the worst-case prompt contribution of a single
 * skill; over-long content is truncated rather than dropped so legitimate large
 * skills still work in a reduced form.
 */
const SKILL_LIMITS = {
  /** Max chars for the skill name (used in the prompt header). */
  name: 100,
  /** Max chars for the one-line frontmatter description. */
  frontmatter: 300,
  /** Max chars for the full instruction body. */
  instructions: 8000,
  /** Max number of match domains. */
  domains: 20,
  /** Max chars for a single domain. */
  domain: 253,
  /** Max number of dangerous-action entries. */
  dangerousActions: 50,
  /** Max chars for a single dangerous-action entry. */
  dangerousAction: 200,
  /** Max number of shortcut entries. */
  shortcuts: 50,
  /** Max chars for a shortcut label / value. */
  shortcutField: 300,
} as const;

/**
 * Sanitize a single untrusted string that will be injected into the trusted
 * system prompt: strip control characters (which can obfuscate prompt-injection
 * payloads or corrupt rendering), neutralize sequences that could forge a
 * `<system-reminder>` boundary (so a custom skill can't close/open the
 * injection wrapper and escape its block), and hard-cap the length.
 */
export function sanitizeSkillText(value: string, maxLen: number): string {
  const cleaned = value
 // Strip C0/C1 control chars except tab (\t), newline (\n), carriage return (\r).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u00ad\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
 // Neutralize forged system-reminder open/close tags.
    .replace(/<(\/?\s*system-reminder\b[^>]*)>/gi, "[$1]");
 // Neutralize ALL prompt-level tags so a custom skill can't forge a trusted
 // block (<user_request>/<plan>/<security_rules>/<site_memory>/\u2026) inside the
 // trusted system prompt it is injected into.
  const neutralized = neutralizePromptTags(cleaned);
  // Truncate on code POINTS (not UTF-16 code units) so a maxLen that
  // lands inside a surrogate pair / emoji doesn't split it into garbage.
  // Use a for...of loop to count code points without allocating an array
  // upfront — only build the array if truncation is actually needed.
  let codePointCount = 0;
  for (const _ of neutralized) codePointCount++;
  if (codePointCount <= maxLen) return neutralized;
  const cps: string[] = [];
  for (const cp of neutralized) {
    cps.push(cp);
    if (cps.length >= maxLen) break;
  }
  return cps.join("");
}

/**
 * Sanitize a single domain input string: strip scheme, path, port, leading dots,
 * wildcard prefix, and trailing slashes.
 */
function sanitizeDomainInput(raw: string): string {
  return sanitizeSkillText(raw, SKILL_LIMITS.domain)
    .trim()
    .replace(/^https?:\/\//i, "")
    .split(/[?#]/)[0]
    .split("/")[0]
    .replace(/:[0-9]+$/, "")
    .replace(/^\./, "")
    .replace(/^\*\./, "")
    .replace(/\/+$/, "");
}

/**
 * Normalize a raw custom-skill's `domains` (or legacy `domain`) into a
 * validated string array. Returns `[]` if no valid domains remain.
 */
function normalizeDomains(s: Record<string, unknown>): string[] {
  const raw: string[] = (
    Array.isArray(s.domains)
      ? s.domains.filter((d): d is string => typeof d === "string" && d.length > 0)
      : typeof s.domain === "string"
        ? [s.domain]
        : []
  );
  return raw
    .map(sanitizeDomainInput)
    .filter((d) => d.length > 0 && isValidSkillDomain(d))
    .slice(0, SKILL_LIMITS.domains);
}

/**
 * Normalize a raw custom-skill's `shortcuts` into a validated Record.
 * Returns `undefined` if no valid shortcuts remain.
 */
function normalizeShortcuts(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entries = (
    Object.entries(raw as Record<string, unknown>).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string",
    ) as Array<[string, string]>
  )
    .slice(0, SKILL_LIMITS.shortcuts)
    .map(
      ([k, v]) =>
        [
          sanitizeSkillText(k, SKILL_LIMITS.shortcutField),
          sanitizeSkillText(v, SKILL_LIMITS.shortcutField),
        ] as [string, string],
    )
    .filter(([k]) => k.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Normalize a single raw custom-skill object into a validated {@link DomainSkill}.
 *
 * `chrome.storage.local` is the trust boundary for custom skills: a corrupted
 * or injected payload must not flow verbatim into the (TRUSTED) system prompt.
 * We require `name` + at least one `domain`, coerce `instructions`/`frontmatter`
 * to strings, constrain the optional `dangerousActions` / `shortcuts` shapes,
 * and — because this content is untrusted — content-sanitize and length-cap
 * every field so a hostile/oversized payload cannot inject prompt boundaries or
 * bloat the system prompt (token / cost DoS).
 * Returns `null` for any object that fails validation so the caller can drop it.
 */
export function normalizeCustomSkill(raw: unknown): DomainSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name) return null;

  const name = sanitizeSkillText(s.name, SKILL_LIMITS.name);
  if (!name) return null; // name collapsed to empty after sanitization
  if (BUILT_IN_SKILL_NAMES.has(name)) return null; // built-in name collision — unreachable custom skill

  const domains = normalizeDomains(s);
  for (const d of domains) normalizeDomainForMatch(d);

  if (domains.length === 0) return null; // a skill with no domain can never match

  const frontmatter =
    typeof s.frontmatter === "string"
      ? sanitizeSkillText(s.frontmatter, SKILL_LIMITS.frontmatter)
      : name;
  const instructions =
    typeof s.instructions === "string"
      ? sanitizeSkillText(s.instructions, SKILL_LIMITS.instructions)
      : "";
  const dangerousActions = Array.isArray(s.dangerousActions)
    ? s.dangerousActions
        .filter((d): d is string => typeof d === "string")
        .map((d) => sanitizeSkillText(d, SKILL_LIMITS.dangerousAction))
        .filter((d) => d.length > 0)
        .slice(0, SKILL_LIMITS.dangerousActions)
    : undefined;
  const shortcuts = normalizeShortcuts(s.shortcuts);

  return {
    domains,
    name,
    frontmatter,
    instructions,
    ...(dangerousActions && dangerousActions.length ? { dangerousActions } : {}),
    ...(shortcuts && Object.keys(shortcuts).length ? { shortcuts } : {}),
  };
}

/** Validate a raw `chrome.storage.local` value into a clean `DomainSkill[]`. */
function validateCustomSkills(stored: unknown): DomainSkill[] {
  if (!Array.isArray(stored)) return [];
  const out: DomainSkill[] = [];
  for (const item of stored) {
    const skill = normalizeCustomSkill(item);
    if (skill) out.push(skill);
    else console.error("[domain-skills] Skipping malformed custom skill:", item);
  }
  return out;
}

async function loadCustomDomainSkills(): Promise<DomainSkill[]> {
  if (customSkillsCache !== null) return customSkillsCache;
  try {
    if (isExtensionWithLocal()) {
      const res = await chrome.storage.local.get(CUSTOM_SKILLS_STORAGE_KEY);
      customSkillsCache = validateCustomSkills(res[CUSTOM_SKILLS_STORAGE_KEY]);
      return customSkillsCache;
    }
  } catch (e) {
    console.error("[domain-skills] Failed to load custom skills from storage:", e);
  }
 // Non-extension context or storage access denied: cache the empty result so
 // the `customSkillsCache !== null` short-circuit works and we don't re-run
 // the (no-op) path on every call.
  customSkillsCache = [];
  return customSkillsCache;
}

/**
 * Lightweight skill descriptor — name + frontmatter only. Always in context
 * (the navigator sees this every step so it knows which skills are available
 * without paying the token cost of the full instruction bodies).
 */
export interface SkillFrontmatter {
  /** Skill name (matches what `load_skill` accepts). */
  name: string;
  /** One-sentence description of what the skill covers. */
  description: string;
}

/**
 * Get the lightweight frontmatter (name + one-sentence description) for every
 * skill matching the given URL. This is the "always in context" view — the
 * navigator sees the names and short descriptions every step and uses
 * `load_skill` to pull the full instructions on demand.
 *
 * Invalid URLs return an empty array (fail-safe). In non-extension contexts
 * (no chrome.storage) only built-in skills are returned.
 */
export async function getSkillFrontmatter(url: string): Promise<SkillFrontmatter[]> {
  const skills = await getDomainSkills(url);
 // De-duplicate by name (twitter.com + x.com both match for the same page —
 // the navigator only needs to see "Twitter/X" once in its available-skills list).
  const seen = new Set<string>();
  const out: SkillFrontmatter[] = [];
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      description: s.frontmatter ?? s.name ?? "",
    });
  }
  return out;
}

/**
 * Get the full instruction body for a named skill (loaded on-demand via the
 * `load_skill` action). Returns the empty string if no skill with that name
 * exists, so the executor can surface a clean "skill not found" message
 * without throwing.
 *
 * Searches both built-in skills AND user-defined custom skills (loaded from
 * chrome.storage.local). The first match wins; built-ins are checked first
 * so user-defined skills can't shadow the bundled ones.
 */
function appendSkillMeta(body: string, skill: DomainSkill): string {
  if (skill.dangerousActions?.length) {
    body += `\n\nDangerous actions on this site: ${skill.dangerousActions.join(", ")}`;
  }
  if (skill.shortcuts && Object.keys(skill.shortcuts).length > 0) {
    body += `\n\nShortcuts:`;
    for (const [label, how] of Object.entries(skill.shortcuts)) {
      body += `\n- ${label}: ${how}`;
    }
  }
  return body;
}

export async function getFullSkill(name: string): Promise<string> {
  for (const skill of BUILT_IN_SKILLS) {
    if (skill.name === name) {
      return appendSkillMeta(skill.instructions, skill);
    }
  }
  const custom = await loadCustomDomainSkills();
  for (const skill of custom) {
    if (skill?.name === name) {
      const body = skill.instructions ?? "";
      return appendSkillMeta(
        `${SKILL_BOUNDARY}${body}${SKILL_BOUNDARY_END}`,
        skill,
      );
    }
  }
  return "";
}

/**
 * Shared internal matcher — used by both {@link getSkillFrontmatter} (always in
 * context) and {@link getFullSkill} (on-demand via the `load_skill` action).
 *
 * Get all matching domain skills for a URL — both built-in AND user-defined
 * custom skills (loaded from chrome.storage.local).
 *
 * Matches the URL's hostname against every skill's `domain`. Invalid URLs
 * return an empty array (fail-safe). In non-extension contexts (no
 * chrome.storage) only built-in skills are returned.
 */
export async function getDomainSkills(url: string): Promise<DomainSkill[]> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  const matches: DomainSkill[] = [];
  for (const skill of BUILT_IN_SKILLS) {
 // check all domains in the array (was single `skill.domain`)
    if (skill.domains.some((d) => hostnameMatches(hostname, d))) {
      matches.push(skill);
    }
  }
 // Merge user-defined custom skills (chrome.storage.local). In the demo /
 // test context (no chrome.storage), this returns [] and the function
 // behaves identically to the old built-in-only version. Custom skills are
 // always normalized by `normalizeCustomSkill` (which sets `domains`), so the
 // legacy single-`domain` fallback here is dead code (finding: redundant
 // legacy `skill.domain` fallback in getDomainSkills is dead code) and has
 // been removed.
  const custom = await loadCustomDomainSkills();
  for (const skill of custom) {
    if (skill.domains.some((d: string) => hostnameMatches(hostname, d))) {
      matches.push(skill);
    }
  }
  return matches;
}
