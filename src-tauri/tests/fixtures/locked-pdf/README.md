# Locked PDF fixtures (FAKE data)

Test documents for unlocking a password-protected PDF at import (#54). They hold only made-up text,
a generated picture and made-up form values. No real person or record is in them.

`MakeFixtures.java` made them with PDFBox 3.0.8, the version CARLOS ships. The encryption follows
CARLOS's `PDFEncryptionUtil`: a `StandardProtectionPolicy` with the same user and owner password
and default permissions. At 256 bits that is AES-256, revision 6.

| File | What it is |
| --- | --- |
| `*-original.pdf` | The unencrypted originals: two pages of text, a picture, a form with filled fields, and an eForm printed to PDF |
| `*-aes256.pdf` | Each original as CARLOS sends it, password `FAKE-portal-2026` |
| `text-aes256-non-ascii.pdf` | The text original, password `FAKE-mot-de-passe-éàç-Łódź-日本` |
| `text-aes128.pdf`, `text-rc4-128.pdf`, `text-rc4-40.pdf` | The text original in older schemes another sender might use |
| `text-aes256-damaged.pdf` | `text-aes256.pdf` cut to three fifths, like a broken download |

The passwords are fixture values, not secrets.

To make them again (the output differs byte for byte, because encryption uses random salts):

```sh
M=~/.m2/repository
CP=$M/org/apache/pdfbox/pdfbox/3.0.8/pdfbox-3.0.8.jar:$M/org/apache/pdfbox/pdfbox-io/3.0.8/pdfbox-io-3.0.8.jar:$M/org/apache/pdfbox/fontbox/3.0.8/fontbox-3.0.8.jar:$M/commons-logging/commons-logging/1.4.0/commons-logging-1.4.0.jar
java -cp "$CP" MakeFixtures.java .
```

SHA-256 of the committed files:

```
04b63f15625a531d6953b2a89d36141d8efdc31cb206cf71d2bcb102e6a7f78b  eform-aes256.pdf
4b99a2ddd022381a1005927583a11eedea56bd1b392e924119b9deb1cf3b20af  eform-original.pdf
11fe58ba9a98c39fe3b88852e43a6b0e749c38c31aa8bb0c7cf701ff050fb726  form-aes256.pdf
d84d6642a2d9e37d5f8d68f835cb49d1671f6bcba97c8e6590613d2dc24c1c46  form-original.pdf
7921742a30fd9d65268c489d77b2a13c5f07d8c8b5d1d671342a1b77cebaf5d1  image-aes256.pdf
6da81c6ff12d65baf8d78ef1fc5fd473f107f30a9212de45d94719857bda132e  image-original.pdf
f5233b9e2659d776e449cbfa71dafb7c5a2d1ae91f98a186cf9b8e124c4f6506  text-aes128.pdf
57e217855179a2ba4fa836fa68578af9a268e702b11eebfd7b2c9b9be0e32dc5  text-aes256-damaged.pdf
81cb2bfbbd6399f9fd68d6b0f0f92ec6b4c2d7182e8b764010d7da8675e70d5e  text-aes256-non-ascii.pdf
a48b3b830dacd8744bf01c06e3e18d79ca271a0f10795c2707f3a145fe1ce1f8  text-aes256.pdf
41e61a36137b8f4c79a284a73adb36d634708625831c88c60e05e961756d51a9  text-original.pdf
976fa239c73076c5cb4eca4d1d3f17ed818d1992c3227db2ca1d5775e9be3a81  text-rc4-128.pdf
0407d8929767141a7f7edcd331534e67b1a881225cb695b71ab25fcbd7aea0a0  text-rc4-40.pdf
```
