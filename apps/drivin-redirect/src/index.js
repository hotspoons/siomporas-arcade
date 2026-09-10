// drivin.siomporas.com → stuntin.siomporas.com.
//
// The game was called Drivin' when it went up, and the address is out there in links and bookmarks
// and this repository's own history. A Worker with nothing but a redirect keeps those working: it
// holds the old custom domain so Cloudflare keeps the DNS record, and sends everything on to the new
// one with the path and query intact, permanently.

const TO = 'stuntin.siomporas.com'

export default {
  fetch(request) {
    const url = new URL(request.url)
    url.hostname = TO
    return Response.redirect(url.toString(), 301)
  },
}
