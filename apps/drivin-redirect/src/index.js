// drivin.siomporas.com → stuntin.siomporas.com.
//
// The game was called Drivin' when it went up, and the address is out there in links and bookmarks
// and this repository's own history. A Worker with nothing but a redirect keeps those working: it
// holds the old custom domain so Cloudflare keeps the DNS record, and sends everything on to the new
// one with the path and query intact, permanently.

const TO = 'https://arcade.siomporas.com/stuntin'

export default {
  fetch(request) {
    const url = new URL(request.url)
    // The whole subdomain becomes one path inside the arcade, so a bookmark of a deeper old URL
    // has nowhere exact to land — the game's own front door is the honest answer for all of them.
    return Response.redirect(TO + url.search, 301)
  },
}
