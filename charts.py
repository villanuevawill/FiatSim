import matplotlib.pyplot as plt
import json

f = open('fiatsim.json')
data = json.load(f)

x = [x["startingDaiBalance"] for x in data]
y = [y["netAPY"] for y in data]

plt.plot(x, y)
plt.title('APR per Dai Balance Folded')
plt.xlabel('Starting Dai Balance')
plt.ylabel('APR')
plt.show()

f.close()
