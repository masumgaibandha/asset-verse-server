app.post('/users', async (req, res) => {
  const user = req.body; 
 

  if (!user?.email) {
    return res.status(400).send({ message: 'email is required' });
  }

  const email = user.email;
  const existing = await usersCollection.findOne({ email });

  // If user already exists, keep role, update only display info (safe)
  if (existing) {
    const updateDoc = {
      $set: {
        displayName: user.displayName || existing.displayName,
        photoURL: user.photoURL || existing.photoURL,
        updatedAt: new Date(),
      }
    };

    // optional: if existing is HR, allow updating company fields
    if (existing.role === 'hr') {
      updateDoc.$set.companyName = user.companyName || existing.companyName;
      updateDoc.$set.companyLogo = user.companyLogo || existing.companyLogo;
    }

    const result = await usersCollection.updateOne({ email }, updateDoc);
    return res.send({ message: 'user already exists', updated: result.modifiedCount > 0 });
  }

  // New user create
  const newUser = {
    displayName: user.displayName || '',
    email,
    photoURL: user.photoURL || '',
    role: user.role === 'hr' ? 'hr' : 'employee',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // HR defaults (AI requirement: free 5 employee limit)
  if (newUser.role === 'hr') {
    newUser.companyName = user.companyName || '';
    newUser.companyLogo = user.companyLogo || '';
    newUser.subscription = 'basic';
    newUser.packageLimit = 5;
    newUser.currentEmployees = 0;
  }

  const result = await usersCollection.insertOne(newUser);
  res.send(result);
});

// Get a single user by email (profile)
app.get('/users/:email', async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send(user);
});

// Get role by email (for later role-based UI/routes)
app.get('/users/:email/role', async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send({ role: user?.role || 'employee' });
});
