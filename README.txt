CKD Inventory & Logistics - Server + Worker Mobile App
=======================================================

PEHLI DAFA (office PC par, sirf ek baar)
1. https://nodejs.org se "LTS" version install karein (Next, Next, Finish).
2. Is poore folder ko PC par kisi jagah rakh lein (jaise C:\CKD-LMS-Server).
3. "start-server.bat" par double click karein. Kaali window khulegi aur browser mein software khul jayega.
   Yeh window software chalte waqt khuli rehni chahiye (minimize kar sakte hain).

PAKKA APP + PAKKA LINK
- Worker ke phone mein "Install App" ka button aata hai (Android Chrome) ya Share > Add to Home Screen (iPhone). Yeh https link par hi hota hai.
- Free link badalta rehta hai, isliye PERMANENT-LINK-GUIDE.txt padhein aur pakka link lagayen.
- install-autostart.bat: PC on hote hi server khud chalta hai, sleep nahi hota.

AGAR KUCH NAZAR NA AAYE
- Zip ke andar se file na chalayen: zip par right-click > "Extract All", phir extract hue folder ke andar se chalayen.
- Kaali window band na karein. Pehli dafa internet mode mein cloudflared (~40 MB) download hota hai, window mein percentage likhi aati hai.
  Purane folder mein cloudflared.exe ho to usay naye folder mein copy kar dein, download nahi hoga.
- "Port 3000 pehle se istemal mein hai" likha aaye to purani server wali kaali window band karein.

PURANA DATA LANA
Purani HTML file mein: Settings > Download Backup.
Naye software (localhost:3000) mein: Settings > Restore from Backup.

INTERNET SE WORKERS (kisi bhi jagah se, kisi bhi internet se)
1. "start-online.bat" se server chalayen (start-server.bat ki jagah).
   Pehli dafa cloudflared (~40 MB) khud download hota hai, phir kaali window mein likha aata hai:
   *** WORKERS KA INTERNET LINK: https://xxxx.trycloudflare.com/worker/ (PIN: ......) ***
2. Yeh link workers ko WhatsApp kar dein (ya Settings ka QR dikha dein). Worker ka mobile data ya kisi bhi WiFi par chalega.
3. Internet mode mein PIN aur admin password khud mazboot ban jate hain (config.json mein likhe hain).
3b. Agar Cloudflare se link na bane (kuch internet providers ise block karte hain), server khud "localhost.run" (Windows ke ssh se)
   try karta hai. Kaali window mein sach mein bana hua link "https://xxxx.trycloudflare.com" ya "https://xxxx.lhr.life" aisa hota hai.
   "api.trycloudflare.com" asli link NAHI hai - woh Cloudflare ka apna server hai.
4. Dhyan: is free link ka naam har dafa server start karne par badal jata hai. Roz naya link bhejna na pade
   to Cloudflare ka permanent tunnel (apna domain) ya cloud server istemal karein, phir config.json mein
   "publicUrl": "https://aap-ka-link" likh dein, aur start-online.bat chalayen.
5. Galat PIN 8 dafa lagane par 10 minute ke liye block ho jata hai. Main software internet se sirf admin password ke saath khulta hai.

WORKERS KE LIYE
Worker app mein 5 tabs: Containers (search + Gate Mark + Offload), Parts Ramp, Welding Ramp, Transit, Done.
Worker container ko "Gate Mark" karta hai -> woh Parts/Welding Ramp mein aa jata hai -> "Offload" form bharta hai.
Har kaam office software mein foran nazar aata hai.

Office WiFi ke liye:
1. Software mein Settings kholein: "Workers Mobile App" card mein link, QR aur PIN likha hai.
2. Worker ka mobile office WiFi se connected ho. QR scan karein ya link browser mein kholein.
3. Naam + PIN likh kar login. Browser menu > "Add to Home screen" se icon ban jata hai.
4. Workflow: office mein container "gate mark" hota hai -> worker ke Offload tab mein aa jata hai ->
   worker form bhar kar Save karta hai -> office software mein foran Offloaded Record, Live Stock, Transit sab update.
   Agar mobile ka net/WiFi chala jaye to offload mobile mein save rehta hai aur connect hote hi khud sync hota hai.

SECURITY (config.json)
 workerPin      : workers ka PIN (Settings se bhi badal sakte hain)
 adminPassword  : khali ho to main software sirf isi office PC (localhost) par khulta hai.
                  Doosre office PC se kholna ho to yahan password likhein.
 port           : 3000 (agar kisi aur program ne le rakha ho to badal dein)
Workers sirf /worker/ wali screen aur PIN se allowed kaam kar sakte hain.

DATA AUR BACKUP
data\state.json  : poora data (data\packing\ mein packing lists)
data\backups\    : har din ka automatic backup (aakhri 30 din)
Is "data" folder ki copy kisi USB / doosre computer par rakhte rahein.

WINDOWS FIREWALL
Pehli dafa chalane par Windows "Allow access" poochta hai - "Private networks" par Allow karein,
warna mobile se link nahi khulega.
